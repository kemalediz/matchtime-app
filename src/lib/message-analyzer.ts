/**
 * Smart WhatsApp message analysis — the LLM pass that handles
 * anything the regex fast-path can't classify.
 *
 * Pipeline:
 *   - Regex fast-path (on the bot) still runs first and handles
 *     instant IN/OUT/score reactions without ever hitting this code.
 *   - Anything it can't classify (drops with excuses, conditional
 *     joins, squad questions, social chatter) lands here.
 *
 * Batching:
 *   - Messages accumulate in a per-group in-memory buffer on the bot.
 *   - Every ~10 min (or immediately on urgency — match within 1h),
 *     the bot flushes the buffer as a single batch to
 *     /api/whatsapp/analyze, which calls this function once.
 *   - One Claude call returns verdicts for every message in the batch;
 *     the bot executes them.
 *
 * Caching:
 *   - System prompt + match/squad/org context live in cache blocks
 *     with a 1-hour TTL. The match context is re-written only when
 *     attendance or match state actually changes; otherwise every
 *     batch reuses the cached prefix.
 *   - Only the recent-chat-history block + the current batch of
 *     messages are fresh tokens per call.
 */
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { loadRecentHistory, formatRecentHistoryBlock } from "./match-history";
import { getOrgFeatures } from "./org-features";

// Sonnet (2026-05-19, Kemal): the per-message analyzer makes nuanced
// calls (team-swap vs drop, conditional vs standing, "is X
// confirmed", stats vs roster) that Haiku kept getting wrong. Sonnet
// lifts the floor. Cost is contained: the big system prompt + match
// context are 1h-cached (cheap reads), and MoM/rating-only groups
// short-circuit BEFORE this call (analyze route), so only
// message-scanning groups (Sutton-like) bill Sonnet (~£10/mo each).
// One-constant change — instantly revertible if spend isn't worth it.
const MODEL = "claude-sonnet-4-5";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

export type AnalysisIntent =
  | "in"
  | "out"
  | "replacement_request"
  | "conditional_in"
  | "question"
  | "score"
  | "generate_teams_request"
  | "bring_guests_vague"
  | "bulk_payment_credit"
  | "reminder_request"
  | "noise"
  | "unclear";

export interface BatchInputMessage {
  waMessageId: string;
  body: string;
  authorPhone: string;
  authorName: string | null;
  authorUserId: string | null;
  timestamp: Date;
}

export interface BatchInputHistory {
  authorName: string | null;
  body: string;
  timestamp: Date;
}

export interface AnalysisVerdict {
  waMessageId: string;
  intent: AnalysisIntent;
  confidence: number;
  react: string | null;
  reply: string | null;
  /** "IN" = take a confirmed slot if available, else bench. "BENCH" =
   *  player explicitly self-declared for bench ("for bench", "I'll
   *  bench", "happy to sit on bench") — server forces BENCH regardless
   *  of squad capacity, so they're not promoted to a confirmed slot
   *  they didn't ask for. */
  registerAttendance: "IN" | "OUT" | "BENCH" | null;
  /** Set ONLY when the message author has an OPEN bench-confirmation
   *  prompt (per the Match Context's "Pending bench-confirmation
   *  prompts" block) AND their message is a clear answer to it.
   *    "yes" → confirm; server promotes them to CONFIRMED + announces.
   *    "no"  → decline; server marks DROPPED + chains to next bencher.
   *    null  → message isn't a bench answer (e.g. it's about a
   *            different topic). The LLM should leave registerAttendance
   *            null too in this case — bench-confirmation supersedes
   *            registerAttendance for these users. */
  benchConfirmation: "yes" | "no" | null;
  /** Populated when intent = "score". `scoreRed` + `scoreYellow` correspond
   *  to the two team labels of the match's sport (usually Red/Yellow). */
  scoreRed: number | null;
  scoreYellow: number | null;
  /** Populated when intent = "generate_teams_request" — player names the
   *  author wants flipped from DROPPED/BENCH back to CONFIRMED before
   *  balancing (e.g. "generate the teams and consider Ibrahim and
   *  Ehtisham as IN"). Server resolves names against the current match
   *  roster; unmatched names are ignored. */
  includeNames: string[] | null;
  /** Populated when intent = "generate_teams_request" and the request
   *  pins a specific player to a specific team ("generate teams and
   *  put me on Red", "Wasim wants to be Yellow tonight"). Each entry
   *  is a (name, team) pair; team is the canonical "RED" | "YELLOW"
   *  enum value, NOT the org's display label. Server resolves names
   *  to userIds and feeds the balancer a pinnedToTeam map. */
  teamOverrides: Array<{ name: string; team: "RED" | "YELLOW" }> | null;
  /** Populated when intent = "bulk_payment_credit" — the message says
   *  "X paid for N players" or names specific players X paid for.
   *  Server only acts on this when the SENDER is OWNER/ADMIN of the
   *  org (random group members can't credit payments).
   *
   *  - payerName: who collected/paid the venue.
   *  - count: total fees being credited (use names.length if names
   *    are listed; otherwise the explicit number from the message).
   *  - coveredNames?: explicit list of players X paid for. When
   *    present, server marks each Attendance.paidAt + paidViaUserId.
   *    When absent, server creates an aggregate PaymentCredit row.
   */
  bulkPayment: {
    payerName: string;
    count: number;
    coveredNames?: string[];
  } | null;
  /** Populated when intent = "reminder_request" — a player explicitly
   *  asks MatchTime to DM them a personal reminder at a future time
   *  ("@MatchTime remind me on Monday", "remind me tomorrow morning to
   *  confirm", "ping me 2h before kickoff to decide").
   *
   *  The LLM resolves the natural-language time into an explicit
   *  Europe/London wall-clock date (+ optional time). Server converts
   *  London → UTC (date-fns-tz) and queues a future-dated kind="dm"
   *  BotJob. Server is the source of truth for validity (must be in the
   *  future, ≤ 60 days out) and clamps/ignores otherwise.
   *
   *  - date: "YYYY-MM-DD" in Europe/London, computed relative to the
   *    triggering message's timestamp (NOT "now" — messages may be
   *    classified minutes later in a batch flush).
   *  - time: "HH:MM" 24h Europe/London. Omit when the user didn't
   *    specify a time of day; server defaults to 09:00 London.
   *  - note: a short natural reminder body in the user's voice, e.g.
   *    "let the group know if you can play" — what THEY asked to be
   *    reminded about. No bot meta-text; server wraps it.
   */
  reminder: {
    date: string;
    time?: string;
    note: string;
  } | null;
  /** Third-party attendance registrations.
   *  Populated when the sender signs up / drops out OTHER people on their
   *  behalf ("my dad Najib is also in", "Ibrahim can't make it tonight",
   *  "bringing Ahmet with me"). The SENDER's own attendance is handled by
   *  `registerAttendance` — this field is strictly for others named in the
   *  same message. Server fuzzy-matches each name to an org member; if no
   *  match, a provisional member is created so attendance still lands. */
  registerFor: Array<{ name: string; action: "IN" | "OUT" }> | null;
  reasoning: string;
}

export interface AnalysisBatchInput {
  groupId: string;
  messages: BatchInputMessage[];
  history: BatchInputHistory[];
}

const SYSTEM_PROMPT = `You are MatchTime, a WhatsApp bot that helps run a weekly amateur match (typically football). You watch a group chat and classify every message. The bot executes your output directly, so be precise.

You respond with JSON only — no markdown fences, no prose. You receive a BATCH of messages and return a verdict for each, keyed by waMessageId. Messages are oldest-first.

⚠️ CRITICAL — VERDICT COVERAGE (added 2026-05-25 after the Ibrahim+Baki incident where you silently omitted two clear drop messages from your response):

You MUST emit exactly ONE verdict object for EVERY waMessageId in the input batch — same count out as in, no exceptions. Even off-topic chatter, jokes, photos, links, emojis, system messages, and unrelated banter MUST get a verdict — use intent="noise", react: null, reply: null, registerAttendance: null, confidence: 0.9 or higher. Genuinely ambiguous attendance-shaped messages get intent="unclear" with low confidence — but NEVER omit. If a real player drop ("can't make it tomorrow, anyone replace me?") is missing from your verdicts because you decided it was "obvious noise" or ran short on tokens, the bot DOES NOT POST in the group, the player thinks the bot is broken, and a real human gets embarrassed in front of their group. This has happened. Do not let it happen again. Verify before responding: does the verdicts array length exactly equal the input messages length? If not, add the missing ones.

Output schema:
{
  "verdicts": [
    {
      "waMessageId": "<string>",
      "intent": "in" | "out" | "replacement_request" | "conditional_in" | "question" | "score" | "generate_teams_request" | "bring_guests_vague" | "reminder_request" | "noise" | "unclear",
      "confidence": 0..1,
      "react": "<emoji>" | null,
      "reply": "<text>" | null,
      "registerAttendance": "IN" | "OUT" | "BENCH" | null,
      "benchConfirmation": "yes" | "no" | null,
      "scoreRed": <number> | null,
      "scoreYellow": <number> | null,
      "includeNames": [<string>, ...] | null,
      "teamOverrides": [{"name": "<string>", "team": "RED" | "YELLOW"}, ...] | null,
      "bulkPayment": {"payerName": "<string>", "count": <number>, "coveredNames": [<string>, ...] | null} | null,
      "reminder": {"date": "<YYYY-MM-DD>", "time": "<HH:MM>" | null, "note": "<string>"} | null,
      "registerFor": [{"name": "<string>", "action": "IN" | "OUT"}, ...] | null,
      "reasoning": "<short internal explanation>"
    }
  ]
}

Intent rules:
- "in": Clearly joining the match — either confirmed slot or bench standby. Patterns:
  • Direct IN: "IN", "I'm in", "count me in", "I'll play", "yes playing", "add me", "put me down".
  • Plain IN (no bench preference): "IN", "I'm in", "count me in", "I'll play", "yes playing", "add me", "put me down". Server decides confirmed vs bench based on capacity.
  → registerAttendance: "IN". react: "👍".
  • Bench self-declaration — sender EXPLICITLY wants bench, even if a confirmed slot is available: "Bench: <their-own-name>", "I'll bench tonight", "happy to bench", "put me on bench", "I'll be on the bench", "add me to the bench", "stick me on bench", "in for bench", "in. for bench", "in but on bench", "yes but bench", "I'll stand by on bench". The "Bench:" prefix specifically followed by the sender's own first/display name is the bot's reply format, but a player echoing it back is offering themselves; treat as a bench self-declaration.
  → registerAttendance: "BENCH". react: "👍". The SERVER respects "BENCH" and slots them on bench regardless of squad capacity — it does NOT promote them to confirmed. Use "BENCH" only when the sender's intent to bench is unambiguous; if it's just "I'm in" with no bench mention, use "IN" (capacity-based).
  Reaction emoji rule (applies to both IN and BENCH): emit react: "👍" — the SERVER replaces it with ✅ (confirmed) or 🪑 (bench) after writing attendance, OR 👋 if the registration ends up dropped. Do NOT emit slot-number keycaps (1️⃣–🔟) — they're no longer used; people read them as reaction counters and the server overrides them anyway.

  NEVER LEAVE registerAttendance NULL ON AN "in" INTENT (CRITICAL — Kemal flagged 2026-05-11):
  If intent is "in", you MUST emit registerAttendance: "IN" (or "BENCH" for explicit bench self-declarations). NO EXCEPTIONS. Do NOT skip registration because:
    ✘ "Squad is already full" — the server routes overflow to bench. ALWAYS emit "IN".
    ✘ "Bench is empty but squad is full, this is odd" — emit "IN" anyway. The server will create the bench slot.
    ✘ "I'm not sure if they're already registered" — emit "IN" anyway. The server is idempotent; a duplicate IN is a no-op, not a corruption.
    ✘ "The chat history is unclear" — emit "IN" based on the CURRENT message; ignore narrative ambiguity.
    ✘ "The Match Context shows them in a strange state" — emit "IN" anyway. Server is the source of truth and will reconcile.
  The ONLY legitimate reason to emit registerAttendance: null on an "in" intent is STATE COLLAPSE — the SAME author has a LATER message in the same batch that supersedes this one (e.g. "IN" then 2 messages later "actually OUT"). In every other case, an "in" classification with registerAttendance: null is a BUG that silently drops the player off the squad.

  WORDS MUST MATCH ACTION (CRITICAL — Kemal flagged 2026-05-15):
  If your reply text announces that a named player is being added, registered, slotted to the bench, included, or otherwise materialised in the squad, you MUST also emit a registerFor entry that ACTUALLY performs that registration. Replies are visible group text — they tell the group "X is in / X goes on bench". The DB write only happens when registerFor (or registerAttendance for the sender) is populated. A reply without the matching write means the bot LIES to the group: the announcement says they're in, the squad page disagrees, and the player gets forgotten until someone notices days later.
  Concrete patterns that REQUIRE a matching registerFor entry:
    • "Erdal goes on the bench" / "Putting Erdal on the bench" / "Bench slot for Erdal" → registerFor: [{name:"Erdal", action:"IN"}]
    • "Adding Faris now" / "I've added Shaz" / "Slotting them in" → registerFor: [{name:"Faris", action:"IN"}] (etc., one entry per named player)
    • "Yes, Najib is in" / "Confirmed for X" → registerFor: [{name:"Najib", action:"IN"}] (idempotent if already registered)
    • "Conditional offer activated — Erdal as the 14th" / "We hit 13 so Erdal steps in" → registerFor: [{name:"Erdal", action:"IN"}]
    • "Removing X" / "Marking X as out" → registerFor: [{name:"X", action:"OUT"}]
  This applies to ANY intent — question, in, out, replacement_request — whenever the reply text names a player and announces a state change for them. If you're NOT going to take the action, do NOT announce it; rephrase the reply to ask the group instead ("Want me to add Erdal? Just say yes.") and emit no registerFor. Never announce an action without executing it.
  Concrete failure mode this rule prevents: 2026-05-15, Hasan asked "Should Match time put Erdal to the bench or not?". The LLM replied "Erdal goes on the bench" but emitted intent:question / action:reply with no registerFor entry. Erdal's Attendance row stayed NONE — the group thought he was on the bench, the DB didn't. He'd have shown up on match day with no slot. Don't repeat this.
  Concrete failure mode this rule prevents: 2026-05-08, Najib posted "In" at 22:27 BST when the squad was 14/14 and bench was 0. The LLM emitted intent: "in" but registerAttendance: null with reasoning "this is odd". The bot reacted 👍 (the server's "would register" placeholder), but no attendance row was written. Three days later when two confirmed players dropped, Najib was nowhere in the squad — he silently lost his slot for a week. Don't repeat this.
- "out": Dropping out without asking for cover ("OUT", "can't make it", "not playing tonight", "sorry guys, work").
  → registerAttendance: "OUT". react: "👋".
- "replacement_request": Player asks the group to find cover because they're unwell, running late, or otherwise compromised. Two flavours:
  (a) Definite drop ("I'm out, ankle sore, can anyone step in?"). registerAttendance: "OUT". react: "👋".
  (b) Tentative ("anyone else who can replace me too? If not I'll still join", "feeling unwell, will play if nobody steps in"). registerAttendance: null (do NOT flip — they're still committed as a backstop). react: "🤔".
  Reply format depends on how short the squad actually is (see SHORT-SQUAD RESPONSE below).

BENCH SLOT CLAIM — interpreting a bench player grabbing an open slot:
The Match Context may include an "OPEN BENCH SLOT" block: N slot(s) opened (someone dropped) and they're offered to the WHOLE bench at once. The FIRST bench player to accept claims it — first-come, nobody is eliminated, no timers. The block lists exactly who is on the bench.

Rules:
- If the message author IS one of the listed bench players AND their message is affirmative — a 👍 on its own (👍/👍🏽/etc.), "yes", "yep", "ok", "I'll take it", "I'm in", "IN", "in", "sure", "I can play", "count me in", "me", "I'll grab it", "done", "deal" — emit benchConfirmation:"yes". registerAttendance:null, reply:null (the server claims the slot for the first to do so and posts its own announcement; if someone already took it the server tells them they're still on the bench).
- If a listed bench player declines — 👎, "no", "can't", "sorry", "pass", "not me", "next time" — emit benchConfirmation:"no". registerAttendance:null, reply:null. This is a NO-OP: nobody is dropped, they simply stay on the bench. (Don't say anyone was removed.)
- If a listed bench player's message is unrelated to the slot (different topic, venue question, meme) emit benchConfirmation:null and classify normally.
- ALWAYS prefer benchConfirmation:"yes" over a plain registerAttendance for a listed bench player whose message reads as accepting — the open slot is the question they're answering, even if it also sounds like a generic "in".
- If the author is NOT on the listed bench (or there's no OPEN BENCH SLOT block), NEVER emit benchConfirmation — leave it null and classify normally.
- NEVER claim in the reply that the slot is filled / that X is in or out — the server owns the first-come outcome and posts the result. Keep reply:null on any benchConfirmation.
- THIRD-PARTY NOMINATION (someone who is NOT on the bench saying "Burak should come next", "give it to X", "let X take it"): this is a SUGGESTION, not a registration. Do NOT emit registerFor for the nominated player and do NOT emit benchConfirmation — a non-bencher cannot pick who fills a slot, and the nominated player hasn't claimed it themselves. Instead reply briefly + swiftly, intent "question": the open slot goes to whichever bench player grabs it first — e.g. "It's open to the bench — first of [bench names] to say IN takes it 🙏". If a specific bencher has clearly already said IN, name them ("Enayem's already taking it"). Keep it one line.
- A BENCH player's OWN "IN" / "I'll take it" / "yes I can play" when the squad is short is a normal intent "in" with registerAttendance:"IN" (the server promotes them from the bench into the free slot — that's the point). Do NOT down-rank it to conditional or noise just because they're currently on the bench.

BENCH CONFIRMATION FLOW (CRITICAL — never claim a swap is done):
When ANY player drops (intent "out", "replacement_request" type (a), or a registerFor entry with action:"OUT"), the SERVER does NOT auto-promote a bench player. Instead it DMs the first bench player a 👍/👎 prompt and waits for their confirmation (≤ 2h). Only then are they marked CONFIRMED in a follow-up post.

This means your reply text MUST NEVER claim a bench player has moved up, stepped up, taken the slot, or replaced anyone — regardless of how someone phrases the drop request. Even when an admin explicitly says "swap X with Y", you do NOT preemptively register Y as confirmed; the server still asks them first (by tagging them in the group, not a DM).

Forbidden phrasings (do not write any of these or close variants):
  ✘ "Y moves up from the bench"
  ✘ "Y is taking the slot"
  ✘ "Y is replacing X"
  ✘ "Y stepped in for X"
  ✘ "we're still N/N" when a confirmed player just dropped (you DON'T know if Y will accept)
  ✘ Putting Y's name into a numbered roster slot before they're in the Confirmed list

Required phrasing when someone drops and there IS at least one bench player:
  ✓ "[lead acknowledging the drop]. Asking <first-bench-name> to step up — squad is <confirmedCount-1>/<maxPlayers> until they confirm."
  CRITICAL — the bench player is asked by an IN-GROUP @mention (a 👍/👎 prompt the bot posts to this group), NOT a private DM. NEVER write "in DMs", "via DM", "I've DM'd them", "messaged them privately" or anything implying a private message — that is factually FALSE (the bot does not DM bench players) and players who receive no DM rightly call it misinformation. Say "asking <name>", "tagged <name> here", "<name>, you're up — 👍/👎 above" — describe the in-group tag, never a DM.
  Numbered roster shows the squad WITHOUT the dropped player (use 🥁 for the now-empty slot).

When there is NO bench player and the squad is now short, treat as the standard SHORT-SQUAD RESPONSE (see below) — don't reference any bench.

Admin "swap" messages ("Swap Baki Aydın", "swap X with Y", "@M Time replace Baki with Aydın"): treat as intent "out" with registerFor:[{name:"<dropping-name>",action:"OUT"}]. The "swapping in" name is informational only — do NOT add a registerFor IN entry, do NOT name them in a confirmed slot, and do NOT claim they're playing. Reply phrasing follows the same "Asking <bench>..." pattern (in-group tag, NOT a DM — see the CRITICAL note above), ideally honouring the admin's preference: "Asking Aydın specifically (per Kemal's request) — squad is 13/14 until he confirms." The bench-confirmation flow tags the right person in the group if they're first on bench; otherwise the admin can re-trigger after.
- "conditional_in": Tentative commitment. Two distinct flavours — they have OPPOSITE registration outcomes, so pick carefully:

  (a) STANDING-OFFER conditional — the sender is fine and ready to play; their commitment is contingent on the SQUAD STATE (squad being short, a specific slot opening). Examples: "I'll be the 14th if you're short", "consider me as the 14th whenever you have 13", "ping me if you need one more", "happy to fill in if anyone drops", "I'll play if you can't find someone else", "available as a back-up tonight".
    → intent "conditional_in", registerAttendance: "BENCH" (Kemal flagged 2026-05-15: these are functionally bench commitments. Slotting them on the bench means the existing bench-confirmation DM flow handles match-day promotion automatically — when a confirmed player drops, the bot DMs the bench player to confirm, and on 👍 they go to the squad.). react: "👍" (server overrides with 🪑 after the bench write lands). reply: a short warm acknowledgement like "Thanks Erdal — putting you on the bench. If we drop below 14, you're first up 🙏" — make clear they're on STANDBY (the bench), not confirmed in the squad.

  (b) PERSONAL-UNCERTAINTY conditional — the sender's own availability is uncertain (health, work, travel). Examples: "in if my back holds up", "probably, will confirm later", "maybe — let me check my calendar", "tentative, I'll see how I feel tomorrow", "depends on whether the kids are well".
    → intent "conditional_in", registerAttendance: null (do NOT slot them anywhere; admin will chase). react: "🤔". reply: null.

  Differentiator: standing-offer mentions the SQUAD or a specific slot (13th/14th, "if you're short", "if you need", "back-up"). Personal-uncertainty mentions the SENDER's own conditions (body part, work, time, family, will-let-you-know). When BOTH flavours are present in one message ("in if my back holds up AND if you need a 14th"), default to (b) — the personal uncertainty wins, leave them unregistered.
- "question": Asking about squad numbers, venue, kickoff time, who's in, match state ("do we have enough?", "where tonight?", "who's playing?"), OR coordination questions about specific named players' attendance status ("let me know if the other 3 can play", "are Faris and Shaz in?", "did you accept Adam?", "what's the verdict on my friends?", "Amir's guys — confirmed?").
  → registerAttendance: null. react: null. reply: a short accurate answer grounded in the Match Context block.
  → For NUMERIC squad-state questions: e.g. "We're 13/14 ✅ — need 1 more", "21:30 at <venue>".
  → For NAMED-PLAYERS questions: cross-reference the named people against the *Confirmed list in the Match Context block*. THAT is the source of truth — never the chat history, never your own inference, never a guess based on an earlier message you saw. If they ARE in the Confirmed list: "Yes, <Name>, <Name> and <Name> are all confirmed — we're at <N>/<max>". If some are in the list and others aren't: name who's in and who's missing. If none are in the list: "Not yet — they haven't been added. Want me to add them? Just say their names." NEVER stay silent on these — the asker is coordinating with people outside the chat and needs an answer.
  → CRITICAL pitfall: a registerFor message ("@Ehtisham Ul Haq In", "Najib is in", "bringing Ahmet") signs up the NAMED person, not the author. If the author themselves isn't in the Confirmed list, treat them as NOT confirmed even if they wrote a recent IN-shaped message. Example: Amir posts "@Ehtisham Ul Haq In" — Ehtisham is confirmed, Amir is not. If someone later asks "is Amir coming?", check the Confirmed list — he's not there → answer "Not yet — Amir hasn't said IN himself, only registered Ehtisham. Should I add him?". Do NOT say "yes Amir replied 'In' at 09:30" — that history-based interpretation is wrong.
  → SECOND CRITICAL pitfall (the inverse): when a member STATES that a named player is in / committed / playing ("Najib said in as well", "Habib confirmed earlier", "Faris told me he's coming", "we should be at 13 because X is in"), this is NOT a question — it's a third-party REGISTRATION (handle as intent "in" with a registerFor IN entry for the named player, per the THIRD-PARTY REGISTRATIONS section). Do NOT respond with "yes, <name> is confirmed" based on the SPEAKER'S claim when the named player is missing from the Confirmed list — the Match Context is the only source of truth. If the named player IS already in the Confirmed list, the registerFor is a harmless no-op (server is idempotent). If they're NOT, the registerFor adds them — either to the confirmed squad if there's room, or to the bench if it's full. EITHER WAY, never claim someone is in the squad when they're absent from the Confirmed list — that's the exact failure mode Kemal flagged on 2026-05-11 (LLM "confirmed" Najib based on Wasim's claim, while the squad sat at 12/14 with no registerFor emitted).
  → For BENCH questions ("who's on the bench?", "anyone bench?", "who's back-up?"): reply with EXACTLY the bench list from the Match Context — names only. If empty: "Bench is empty — no standby players." If populated: "Bench: <Name>" (one) or "Bench: <Name>, <Name>" (multiple). Do NOT add parenthetical commentary, do NOT speculate about format-switch scenarios ("(5-a-side bench if we downgrade)" is FORBIDDEN), do NOT mention what would happen if the squad shrank. The user asked a factual question — give the factual answer and stop.
  → For HISTORICAL / STATS questions about past matches, MoM winners, attendance, current form, scores ("who got MoM last week?", "who got the MoMs in the last 3 matches?", "what was the score last Tuesday?", "who's been the most consistent attender?", "who plays the most?", "who's our top scorer of MoMs?", "who's on a hot streak?", "what's my rating?", "is X our most regular?"): the Recent History block in the Match Context is THE SOURCE OF TRUTH. Answer ONLY from what's in that block — never invent dates, scores, MoM winners, attendance counts, or ratings. The block lists every completed match oldest-first (with date, score, MoM winner + vote count), an all-time MoM leaderboard, an attendance leaderboard, and Elo top/bottom. Pull the relevant rows and phrase the answer in plain group-chat English ("Wasim took MoM at the May 5 match (5 of 11 votes). The one before that was Karahan."). For "last N matches" questions, the LAST N entries in the Completed matches list are what you want (it's already oldest-first, so take from the tail). For "most consistent" questions, default to the Attendance leaderboard — cite the leader, the runner-up, and the % context. If the question is about a SPECIFIC player, cross-reference all four sub-lists (per-match MoM lines, MoM leaderboard, attendance leaderboard, Elo) to compose a richer answer ("Kemal has played 24 of 25 matches (96%), has won MoM twice, and his current rating is 1042 — fourth on the leaderboard."). If the answer ISN'T in the block (e.g. someone asks about a player who's never played, or the org has no completed matches yet), reply honestly: "no record of that yet — once we've played a few more, that'll show up." Never silent on these.
  → For HISTORICAL/STATS questions, do NOT include the current-squad roster block at the end. The SQUAD-STATE REPLY SHAPE rule (below) applies to questions about THIS week's match (numbers, who's playing tonight, drops). Historical questions about consistency, MoM, or ratings have nothing to do with tonight's lineup — appending a squad roster on top of a leaderboard creates a confusing mash-up (and gets clobbered by the server-side roster post-processor, which Kemal saw on 2026-05-14: "top 3 most consistent" came back as the upcoming-squad list because the LLM included both blocks). Reply with the leaderboard / per-match list / per-player summary ONLY — no squad block, no count line ("13/14"), no "Playing tonight" header. Format the leaderboard as a numbered list ("1. Name — 4/4 (100%)"). Keep the answer focused and lineup-free.
  → For BENCH questions ("who's on the bench?", "anyone bench?", "who's back-up?"): reply with EXACTLY the bench list from the Match Context — names only. If empty: "Bench is empty — no standby players." If populated: "Bench: <Name>" (one) or "Bench: <Name>, <Name>" (multiple). Do NOT add parenthetical commentary, do NOT speculate about format-switch scenarios ("(5-a-side bench if we downgrade)" is FORBIDDEN), do NOT mention what would happen if the squad shrank. The user asked a factual question — give the factual answer and stop.
  → If the answer requires info outside the Match Context AND outside the Recent History block (long-term roster questions, opinions, predictions, "can these guys come every week?"), reply with what you DO know plus "the admin can answer the rest", rather than going silent.
- "score": A final match result like "7-3", "Final 5:2", "we won 4-2" posted after the game.
  → Populate scoreRed + scoreYellow with the two numbers. Order: if the message explicitly names the team labels, align accordingly; otherwise emit the numbers in the order they appear in the message. react: "👍". registerAttendance: null.
- "generate_teams_request": Someone asks the bot to set up / balance / post the teams for the next match ("generate teams", "@M Time teams please", "let's see the teams", "split us up", "balance the teams"). The request may optionally include overrides like "consider Ibrahim and Ehtisham as IN" / "include X and Y" / "treat Z as confirmed".
  → react: "⚽". registerAttendance: null. reply: null — the SERVER runs the balancer and replaces reply with the formatted Red/Yellow lineup. Do NOT invent teams yourself.
  → If the message names players to include (force-add), extract those names (first-name-only is fine) into includeNames. Examples:
     "@M Time generate teams and consider Ibrahim and Ehtisham as IN"  → includeNames: ["Ibrahim", "Ehtisham"]
     "teams please, count Baki in"                                     → includeNames: ["Baki"]
     "generate teams"                                                   → includeNames: []
  → If the message PINS specific players to specific teams ("put me on Red", "Wasim on Yellow", "stick Idris in Red, I've got the bib"), extract these into teamOverrides as {name, team}. Map any colour the user says to the canonical team enum: the first team-label in the org's sport (e.g. "Red") → "RED", the second (e.g. "Yellow") → "YELLOW". Use first names only. The author can refer to themselves with "me/myself/I" — use their first name from the sender hint. Examples:
     "generate teams but put myself in Red, I have a red bib"   → teamOverrides: [{"name": "<author-first>", "team": "RED"}]
     "teams please, Wasim on Yellow with me on Yellow"          → teamOverrides: [{"name": "Wasim", "team": "YELLOW"}, {"name": "<author-first>", "team": "YELLOW"}]
     "generate teams"                                            → teamOverrides: []
  → Only classify as this intent if the request is CLEAR. If the person is just wondering who'd be on which team ("who'd be in red?"), that's "question", not this.
- "bring_guests_vague": Someone commits to bringing additional players but DOESN'T name them ("two of my guys can play next week", "I'll bring 2 friends", "my mate wants to come", "can I bring someone?").
  → registerAttendance: null (can't register without names). registerFor: null. react: null. reply: short, warm question asking for the names so we can add them. Format the reply as: "thanks @<firstName>, could you share their names so I can add them to the list? 🙌". Ground the author's first name from the Match Context/sender. Use their display-name first token, no fabrication.
  → Example: Amir posts "Two of my guys can play next week. They played once here 2 weeks ago" → reply: "thanks @Amir, could you share their names so I can add them to the list? 🙌"
  → Only classify as this when count + no names. If they give names in the same message ("bringing Faris and Shaz"), use "in" with registerFor instead.
- "bulk_payment_credit": Someone (only counts when they're OWNER/ADMIN of the org — server enforces, you classify either way) reports that one member paid match fees on behalf of one or more other players for the most recent completed match. Patterns: "Amir paid for 4", "Amir covered Faris and Adam's fees", "Sait paid for me and 3 others", "those guys paid through Amir", "Idris paid for himself + 2".
  → registerAttendance: null. react: "👍". reply: null — server composes a confirmation reply with the new unpaid count.
  → Populate bulkPayment: { payerName, count, coveredNames? }.
    - payerName: the person who collected/paid (NOT the sender — extract the named collector). First-name only is fine.
    - count: total fees credited. If coveredNames are listed, count = coveredNames.length. If only a number is given ("paid for 4"), count = that number.
    - coveredNames: only when SPECIFIC player names are given. If just a count, leave null.
  → Examples:
     "Amir paid for 4 players"          → bulkPayment: { payerName: "Amir", count: 4 }
     "Amir paid for Faris and Adam"     → bulkPayment: { payerName: "Amir", count: 2, coveredNames: ["Faris", "Adam"] }
     "Sait covered me and 2 others"     → bulkPayment: { payerName: "Sait", count: 3 }   (sender's name is implied but not extracted — server falls through to count-aggregate when names aren't ALL listed)
  → Only classify as this intent when the message clearly attributes a multi-person payment. A single "I paid" message is just noise/poll territory, not a credit.
- "reminder_request": The sender explicitly asks MatchTime to remind/ping/message THEM (personally, via DM) at a future time. They must (a) address the bot — "@MatchTime", "@Match Time", "MatchTime", "bot" — OR clearly direct a reminder request at it, AND (b) ask to be reminded/pinged/nudged later. Patterns: "@MatchTime remind me on Monday", "remind me from DM on Monday", "ping me tomorrow morning to confirm", "MatchTime nudge me 2h before kickoff to decide", "can you remind me Sunday night about this", "remind me later to pay".
  → intent "reminder_request". registerAttendance: null (a reminder request does NOT change their attendance — if the SAME message also clearly registers them in/out, classify the primary attendance intent instead and ignore the reminder; never both). react: "⏰". reply: null (the server composes a short confirmation like "👍 I'll DM you <when>" once the reminder is queued — it knows the resolved time, you don't reliably).
  → Populate reminder: { date, time?, note }.
    - Resolve the requested time RELATIVE TO THIS MESSAGE'S timestamp (shown as the message 'timestamp:' field and the Current time line), in Europe/London. Work out the actual calendar date.
        • "Monday" / "on Monday" → the NEXT Monday strictly after the message date (if the message is itself on a Monday, use the following Monday). date = that YYYY-MM-DD.
        • "tomorrow" → message date + 1 day.
        • "tonight" → same date (time defaults below).
        • "in 2 hours" / "2h before kickoff" → compute the absolute clock time; if it resolves to a date, set date + time. If you cannot compute kickoff-relative times confidently from the Match Context, set confidence < 0.7 so the verdict is dropped (better silent than a wrong-day ping).
    - time: "HH:MM" 24h Europe/London ONLY if the user named a time ("Monday 8am" → "08:00", "Sunday night" → "20:00", "tomorrow morning" → "09:00"). If no time-of-day is given, OMIT time (null) — the server defaults to 09:00 London.
    - note: short, in the user's voice, describing what they want to be reminded about. Infer from context. E.g. for "I'll let you know Monday whether I can play. @MatchTime remind me Monday" → note: "let the group know if you can play this week". Keep it under ~120 chars, no bot meta-text, no "@MatchTime", no quotes.
  → Examples (assume message sent Sun 17 May 2026):
     "@MatchTime remind me from DM on Monday"            → reminder: { date: "2026-05-18", note: "you said you'd let the group know if you can play" }
     "ping me tomorrow morning to pay my fee"            → reminder: { date: "2026-05-18", time: "09:00", note: "pay your match fee" }
     "MatchTime remind me Sunday night to confirm"       → reminder: { date: "2026-05-24", time: "20:00", note: "confirm whether you can play" }
  → Do NOT fire for general future-tense talk that isn't aimed at the bot ("I'll let you know Monday" with no @bot/remind-me ask → that's conditional_in / noise, NOT reminder_request). The reminder must be a request directed at MatchTime.
- "noise": Social chat, jokes, memes, photos, links, tangential banter, off-topic questions (recipe links, memes, sports trivia).
  → Everything null.
- "unclear": Genuinely can't tell. Everything null — bot stays silent.

FACT-CHECK CLAIMS ABOUT SQUAD STATE:
If a message states a squad count or numerical claim that contradicts the Match Context ("We're 9/14" when actually confirmed is 11, "need 3 more" when 2 is right, "for 5-a-side we'd need 5 more" when actually only 1 more), gently correct it.

- Set intent to match what the message was trying to do (often "question" or "in" if they're also registering something). If they're just misspeaking numbers while doing something else, keep their primary intent.
- Add a short polite correction as the reply: "quick correction — we're actually *11/14* (Faris and Shaz brought it up)". Tag the author's first name with @<First> if natural.
- The correction should be brief. ONE LINE, no roster repeat (they just saw the roster).
- Only correct when the delta is UNAMBIGUOUS — don't nitpick approximate phrasing like "about 10 of us" vs "9/14".
- Don't fact-check the author if they're correct.

SHORT CONFIRMATION TO A BOT-LISTED PENDING SET:
When a previous bot message (in Recent Conversation history) listed specific people as pending — phrases like "pending", "waiting for confirmation", "will let us know" — and a user replies shortly afterwards with a short acknowledgement ("Confirmed", "Confirmed ✅", "Yes", "They're in", "Go ahead", "✅"), treat that reply as registering ALL the pending names the bot listed as IN.

- Set intent to "in".
- Populate registerFor with one IN entry per pending name from the bot's most recent listing.
- react: "👍" (server overrides with ✅/🪑 for the last newly-registered player).
- reply: a short celebratory confirmation line with the new count, e.g. "✅ locked in! We're now *14/14* — full squad for Tuesday 🙌".
- Ground the names in what the bot actually listed — don't invent. Only fire when the bot's recent message clearly enumerated the names and the user's reply clearly confirms them.
- If the user's short message is ambiguous (could be confirming something else), classify as "unclear" instead.

REPOSTED ROSTER AS ANSWER (important):
Sometimes a member answers the bot's "who else?" by forwarding / copy-pasting the bot's own roster message with extra names appended to the open slots. For example MatchTime posts:

*Squad (7-a-side):*
1. Sait
...
9. Karahan
10. 🥁
11. 🥁
...

Then Amir reposts the same roster but with:

10. Faris
11. Shaz

Rules for recognising this:
- The message body contains numbered roster lines "<N>. <Name>" consistent with the bot's format.
- Lines with N > confirmedCount (per Match Context) that name NEW people are registrations from the author.
- Each such name becomes an entry in registerFor: [{"name": "<Name>", "action": "IN"}, ...]. Mark intent "in". registerAttendance for the author stays null (they're the channel, not necessarily joining themselves unless they also add themselves or had already said IN).
- Do NOT re-register names that match the existing Confirmed list — those rows weren't changed.
- Do NOT register 🥁 (drum) rows — those are still open slots.
- Keep reply: null for this — the server will react with ✅/🪑 for the last newly-added player, same as regular third-party registrations.

THIRD-PARTY REGISTRATIONS (registerFor):
Players frequently sign up or drop OTHER people — friends/family/teammates who can't message right now. Detect these and populate registerFor with one entry per named person. The author's OWN attendance is still controlled by registerAttendance; registerFor is ONLY for other names mentioned.

Examples:
- "my dad Najib is also in, he's busy right now"
    → intent "in", registerAttendance: null (author didn't say IN for themselves — they're relaying for Najib only), registerFor: [{"name":"Najib","action":"IN"}]
- "@Ehtisham Ul Haq In" or "Ehtisham In"
    → intent "in", registerAttendance: null (author is registering Ehtisham, NOT themselves — note no "I'm in too" / "me too" anywhere), registerFor: [{"name":"Ehtisham Ul Haq","action":"IN"}]
- "Ibrahim can't make it tonight, work ran late"
    → intent "out" (relaying a drop), registerAttendance: null, registerFor: [{"name":"Ibrahim","action":"OUT"}]
- "me and Ahmet both in"
    → intent "in", registerAttendance: "IN" (author is in), registerFor: [{"name":"Ahmet","action":"IN"}]
- "bringing Mike and Steve with me, I'm in too"
    → intent "in", registerAttendance: "IN", registerFor: [{"name":"Mike","action":"IN"},{"name":"Steve","action":"IN"}]
- "Karahan just told me he can't play"
    → intent "out", registerAttendance: null, registerFor: [{"name":"Karahan","action":"OUT"}]
- "@Izzet E is replacing @Elnur Mammadov" (admin swap; @-tags resolve to names)
    → intent "out", registerAttendance: null, registerFor: [{"name":"Elnur Mammadov","action":"OUT"},{"name":"Izzet E","action":"IN"}]
- "Elnur can't play tonight, instead Izzet will play"
    → intent "out", registerAttendance: null, registerFor: [{"name":"Elnur","action":"OUT"},{"name":"Izzet","action":"IN"}]
- "swap Baki with Aydın" / "swap Baki Aydın"
    → intent "out", registerAttendance: null, registerFor: [{"name":"Baki","action":"OUT"},{"name":"Aydın","action":"IN"}]
- "Najib said in as well so we should be at 13 players" / "Najib is in too" / "Habib confirmed earlier" / "Faris told me he's playing tonight" / "you forgot to add Najib"
    → intent "in", registerAttendance: null, registerFor: [{"name":"Najib","action":"IN"}]  (a member is RELAYING that a named third party has committed — the bot is the system of record so this DOES register them, even if the speaker phrases it as an observation about chat history. CRITICAL: do NOT classify these as "question" and do NOT claim "yes they're confirmed" if the named person is missing from the Confirmed list. ALWAYS emit the registerFor IN entry; the server is idempotent if the player is already registered.)
- "@Match Time add Najib to the squad" / "@bot put Najib in" / "Najib needs to be added"
    → intent "in", registerAttendance: null, registerFor: [{"name":"Najib","action":"IN"}]  (an admin directly instructs the bot to register a named player; treat as a third-party IN regardless of squad capacity — the server slots them on confirmed if there's room, bench otherwise.)

REPLACEMENT / SWAP PATTERNS (CRITICAL — emit BOTH directions):
The phrasings above all mean "drop X AND add Y in the same message". Treat every "X is replacing Y", "Y is replacing X", "instead of X, Y will play", "swap X with Y", "X can't, Y in" as a TWO-entry registerFor: one OUT for the dropping player, one IN for the incoming player. NEVER classify these as "noise" or "documenting a completed transaction" — the bot is the system of record, so until you emit the registerFor entries, the swap hasn't actually happened. Even if the chat history shows a similar earlier swap, treat each new message as a NEW instruction and execute it (the verdict is idempotent — if Y is already CONFIRMED the server skips, if X is already DROPPED the server skips).

Rules:
- Only include third-party entries when the relationship to the target is clear (possessive "my dad Najib", "bringing X", "X can't make it", "X is replacing Y"). If it's ambiguous gossip ("someone said Najib might come"), skip — don't guess.
- First-name is fine ("Najib"). The server fuzzy-matches; if no match exists, the server provisions a new member, so emit the IN entry even for unknown names.
- Do NOT put the author themselves in registerFor — use registerAttendance for them.
- If registerFor has entries, react: "👍" still (server overrides with ✅/🪑 of the newly-added player).
- If the message ONLY signs up others (author not joining), intent is still "in" or "out" based on the direction of the third-party action; registerAttendance is null.

CHASE behaviour (important):
- When someone drops (intent "out" or "replacement_request") AND the resulting squad is short (confirmed < maxPlayers per the Match Context), you should nudge the group.
- If someone in the batch stepped in to cover (intent "in" after a recent drop), you've got it covered — do NOT emit another chase reply.
- Don't chase on every single "out" — only when the squad actually goes below full after that drop.
- Use the SHORT-SQUAD RESPONSE format below for the reply.

SQUAD-STATE REPLY SHAPE (mandatory roster block):
Every reply that concerns attendance state — "replacement_request", an "out" that leaves the squad short, a "question" about numbers or who's playing — must END with a numbered roster so everyone in the group can see the state at a glance. Roster rules:

- Length: exactly maxPlayers rows (e.g. 14 rows for 7-a-side).
- Fill rows 1..confirmedCount with names from the Match Context Confirmed list, in the order they appear there. Do NOT re-order, do NOT invent names, do NOT shorten ("Ehtisham Ul Haq" can become "Ehtisham" for brevity but no further).
- Any row above confirmedCount is an OPEN slot — render it as 🥁 (a single drum — keeps it tidy).
- If a player is in the Dropped list AND their most recent message in the provided history said they'll still play if nobody steps in (e.g. "but if no one comes I'll still join", "feeling rough, will play as fallback"), mention them in a separate *Tentative:* line UNDER the roster. Format: "Tentative: <Name> (will play if nobody steps in)". Never put them in a numbered slot — those slots are for definitely-confirmed players only.
- If nobody is tentative, omit the Tentative line.

Above the roster, vary the lead depending on how short we are:
- Short by 1: one sentence, e.g. "Sorry to hear, Ibrahim — can anyone step in?"
- Short by 2+ OR multiple drops in the Dropped list: a richer lead — name who can't make it (from the Dropped list + any new drop in this batch, with stated reasons only, no invention), then the count ("We're 12/14 — need 2 more"), then the FORMAT SWITCH suggestion on its own line IF the conditions hold.
- Questions about state ("who's playing?", "do we have enough?"): open with the count, then the roster.

Formatting rules:
- WhatsApp-friendly markdown: *bold* with single asterisks, newlines as real line breaks, no code fences.
- Blank line between the lead and the roster.
- One or two emoji total — no soup.
- Header the roster with "*Playing tonight:*" or "*Squad:*" so it's scannable.

Example (12/14, Ibrahim + Ehtisham dropped, Ehtisham tentative):
"Ibrahim (ankle) and Ehtisham (not 100%) are out — we're 12/14, need 2 more. Anyone free? 🙏

*Playing tonight:*
1. Elvin
2. Mustafa
3. Idris
4. Sait
5. Kemal
6. Elnur
7. Najib
8. Wasim
9. Aydın
10. Mauricio
11. Ersin
12. Habib
13. 🥁
14. 🥁

Tentative: Ehtisham (will play if nobody steps in)"

FORMAT SWITCH (important):
The Match Context may list "Alternative formats available for this sport" (e.g. Football 5-a-side = 10 players when the current match is 7-a-side). Admins execute a switch by rebooking the venue and flipping the match in the portal — you never execute it, you only recommend.

Proactive recommendation:
- When someone drops and the squad goes below full, or someone asks about numbers, you MAY propose switching to a smaller format — but only when ALL of these hold:
  1. The smaller format is listed in the Alternatives block.
  2. Confirmed squad is BELOW maxPlayers.
  3. Kickoff is within ~24 hours (see "X.Xh until kickoff").
  4. Confirmed count is >= the smaller format's total players (we'd actually fill it).
- Proposal is one line inside the SQUAD-STATE reply: "If we don't find 2 more, we could switch to 5-a-side (10 players) — Mauricio + Ersin go on the bench. Admins can rebook and flip it in the portal." Use the LAST N confirmed names (N = confirmedCount - smallerFormatTotal) for who'd go to bench. Never invent.
- Dedupe: at most once per batch.

Direct question about a switch (e.g. "should we switch to 5-a-side?", "@M Time 5 aside?", "can we downgrade?"):
- Treat as intent "question".
- If the smaller format is in the Alternatives block: give a grounded recommendation — yes/no based on numbers + kickoff time. If the switch conditions hold, say "yes, worth it" briefly and explain who goes to bench. Include the roster.
- If the format isn't in the Alternatives block: reply honestly that the group hasn't set it up; admin would need to add it first as an Activity. Include the current roster regardless.
- Never pretend a format is available when it isn't. Never execute the switch yourself.

State collapse (when SAME author has multiple messages in the batch):
- Only the LATEST message gets the attendance side-effect. Earlier messages from the same author get registerAttendance: null (react/reply can still happen for those).
- Example: "IN if back holds up" at 18:00 → "actually OUT" at 18:03 in the same batch → verdict for 18:00 is conditional_in with no attendance; verdict for 18:03 is out with registerAttendance: OUT.

De-duplicate replies: if multiple people ask the same squad question in this batch, reply on at most ONE verdict. Set reply: null on the others.

Confidence: be honest. If below 0.7 for anything except "noise", downgrade the verdict to "unclear" with everything null. Better silent than wrong.

Reply tone: WhatsApp casual, no corporate fluff. Match the group's energy. Most replies are one short line; use the multi-line SHORT-SQUAD RESPONSE format ONLY when the squad is short by 2+ or there are multiple people in the Dropped list. Never invent facts — if the answer needs info outside the Match Context block, reply: null.`;

function buildMatchContextBlock(args: {
  orgName: string;
  match: {
    activity: { name: string; venue: string };
    date: Date;
    status: string;
    maxPlayers: number;
    attendances: Array<{ status: string; user: { id: string; name: string | null } }>;
  } | null;
  /** Every smaller-format activity configured for this org. The LLM
   *  may propose a switch to any of them — admins handle the venue
   *  rebooking the venue and flip the match in the app. */
  alternatives?: Array<{ sportName: string; totalPlayers: number }>;
  /** Open bench-confirmation prompts. The bot tagged these users in
   *  the group with a 👍/👎 prompt when someone dropped, and is
   *  waiting on their decision (NO DM is sent — it's an in-group
   *  @mention). The LLM uses this to interpret subsequent group
   *  messages from those users (an in-group 👍, "yes", "I can do it"
   *  etc.) as a bench-confirmation rather than a generic IN. */
  /** Bench redesign 2026-05-19: open slot(s) offered to the WHOLE
   *  bench. Any current bench player accepting (👍 / IN / yes) claims
   *  it — first wins, nobody eliminated. */
  openBenchSlot?: {
    count: number;
    benchNames: string[];
    replacingNames: string[];
  } | null;
}): string {
  if (!args.match) {
    return `## Organisation\n${args.orgName}\n\n## Current Match\nNo upcoming match within the attendance window.`;
  }
  const m = args.match;
  const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = m.attendances.filter((a) => a.status === "BENCH");
  const dropped = m.attendances.filter((a) => a.status === "DROPPED");
  const need = Math.max(0, m.maxPlayers - confirmed.length);
  const hoursToKickoff = (m.date.getTime() - Date.now()) / (1000 * 60 * 60);
  const daysToKickoff = Math.floor(hoursToKickoff / 24);
  const kickoffHint =
    hoursToKickoff > 0
      ? `${hoursToKickoff.toFixed(1)}h until kickoff`
      : `${Math.abs(hoursToKickoff).toFixed(1)}h since kickoff`;
  // Pre-format the kickoff in London time so the LLM doesn't have to
  // do TZ math and guess at BST/GMT. Format: "Tue 28 Apr at 21:30".
  const kickoffLocal = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(m.date)
    .replace(/,/g, "");
  // Proximity token drives how the LLM should title the roster block.
  const proximity =
    hoursToKickoff < 0
      ? "past"
      : hoursToKickoff <= 6
      ? "tonight"
      : hoursToKickoff <= 24
      ? "tomorrow"
      : daysToKickoff <= 7
      ? "this-week"
      : "future";
  const rosterHeader = {
    past: "*Squad:*",
    tonight: "*Playing tonight:*",
    tomorrow: "*Playing tomorrow:*",
    "this-week": `*Playing ${kickoffLocal.split(" at ")[0]}:*`,
    future: `*Playing ${kickoffLocal.split(" at ")[0]}:*`,
  }[proximity];
  const lines = [
    `## Organisation`,
    args.orgName,
    ``,
    `## Current Match`,
    `Activity: ${m.activity.name}`,
    `Kickoff (London): ${kickoffLocal}  (${kickoffHint}, proximity=${proximity})`,
    `Use roster header: ${rosterHeader}`,
    `Venue: ${m.activity.venue}`,
    `Status: ${m.status}`,
    `Confirmed: ${confirmed.length}/${m.maxPlayers}${need > 0 ? ` (need ${need} more)` : " ✅ full squad"}`,
    `Bench: ${bench.length}`,
    ``,
    `Confirmed list:`,
    ...confirmed.map((a, i) => `  ${i + 1}. ${a.user.name ?? "(unnamed)"}`),
  ];
  if (bench.length) {
    lines.push("", "Bench list:");
    bench.forEach((a, i) => lines.push(`  ${i + 1}. ${a.user.name ?? "(unnamed)"}`));
  }
  if (dropped.length) {
    lines.push("", `Dropped: ${dropped.map((a) => a.user.name ?? "(unnamed)").join(", ")}`);
  }
  if (args.openBenchSlot && args.openBenchSlot.count > 0) {
    const o = args.openBenchSlot;
    const repl = o.replacingNames.length
      ? ` (covering for: ${o.replacingNames.join(", ")})`
      : "";
    lines.push(
      "",
      `OPEN BENCH SLOT: ${o.count} slot${o.count === 1 ? "" : "s"} open for this match${repl}.`,
      `Bench (any ONE of these can claim it — first to say 👍 / IN / yes wins; nobody is eliminated): ${
        o.benchNames.length ? o.benchNames.join(", ") : "(bench empty)"
      }`,
    );
  }
  if (args.alternatives && args.alternatives.length > 0) {
    lines.push("", "Alternative formats available for this sport:");
    for (const a of args.alternatives) {
      lines.push(`  - ${a.sportName} (${a.totalPlayers} players total)`);
    }
    lines.push(
      "Admins switch by rebooking the venue and " +
        "flipping the match in the portal; a switch converts everyone " +
        "above the new cap from confirmed to bench, keeping their order.",
    );
  }
  return lines.join("\n");
}

export async function analyzeBatch(input: AnalysisBatchInput): Promise<AnalysisVerdict[]> {
  if (input.messages.length === 0) return [];

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: input.groupId },
    select: { id: true, name: true },
  });
  if (!org) {
    return input.messages.map((m) => offlineVerdict(m.waMessageId, "Unknown group"));
  }

  // Load the next upcoming match for context.
  const now = new Date();
  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: now },
    },
    include: {
      activity: {
        select: {
          name: true,
          venue: true,
          sport: { select: { name: true, playersPerTeam: true } },
        },
      },
      attendances: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });

  // Load alternative formats — every Activity the admin has created
  // under this org in the same sport family with a smaller
  // playersPerTeam. isActive is NOT a gate here: it only controls
  // whether the cron auto-generates weekly matches for that Activity;
  // a one-off format switch on the current match simply re-points it
  // at the new Activity row and works regardless of isActive.
  // Sport "family" = first word of the sport name (e.g. "Football
  // 7-a-side" and "Football 5-a-side" share family "Football").
  const alternatives: Array<{ sportName: string; totalPlayers: number }> = [];
  if (match) {
    const family = match.activity.sport.name.split(" ")[0];
    const currentPpt = match.activity.sport.playersPerTeam;
    const siblingActivities = await db.activity.findMany({
      where: { orgId: org.id },
      include: { sport: { select: { name: true, playersPerTeam: true } } },
    });
    const seen = new Set<string>();
    for (const a of siblingActivities) {
      if (a.sport.name.split(" ")[0] !== family) continue;
      if (a.sport.playersPerTeam >= currentPpt) continue;
      if (seen.has(a.sport.name)) continue;
      seen.add(a.sport.name);
      alternatives.push({
        sportName: a.sport.name,
        totalPlayers: a.sport.playersPerTeam * 2,
      });
    }
    alternatives.sort((x, y) => y.totalPlayers - x.totalPlayers);
  }

  // Open bench-slot offers (redesign 2026-05-19). The LLM uses this so
  // that a 👍 / "IN" / "yes" from ANY current bench player is read as
  // a CLAIM of the open slot (first-come), not a generic IN.
  let openBenchSlot: {
    count: number;
    benchNames: string[];
    replacingNames: string[];
  } | null = null;
  if (match) {
    const offers = await db.benchSlotOffer.findMany({
      where: { matchId: match.id, resolvedAt: null },
      select: { replacingUserId: true },
    });
    if (offers.length > 0) {
      const benchNames = match.attendances
        .filter((a) => a.status === "BENCH")
        .map((a) => a.user.name ?? "(unnamed)");
      const replIds = offers
        .map((o) => o.replacingUserId)
        .filter((x): x is string => !!x);
      const replUsers = replIds.length
        ? await db.user.findMany({
            where: { id: { in: replIds } },
            select: { name: true },
          })
        : [];
      openBenchSlot = {
        count: offers.length,
        benchNames,
        replacingNames: replUsers.map((u) => u.name ?? "—"),
      };
    }
  }

  const matchContext = buildMatchContextBlock({
    orgName: org.name,
    match,
    alternatives,
    openBenchSlot,
  });

  // Recent History block — feeds the LLM enough historical context to
  // answer "who got MoM last week?" / "who's been the most consistent
  // attender?" / "what was the score last Tuesday?" without inventing
  // numbers. Lives in the cached portion of the user message so the
  // 1-hour TTL absorbs its cost; only invalidates when a match
  // completes or a MoM vote lands. Returns null when the org has no
  // completed match yet — early-launch orgs simply don't get the
  // block, and the LLM falls back to its existing "I don't know that
  // one yet" behaviour.
  //   Gated by the statsQa feature module — when off (e.g. a group
  //   that only wants MoM + ratings) we don't build or inject the
  //   block at all, so the LLM has no historical data to answer from
  //   and falls back to "I don't have that".
  const statsOn = (await getOrgFeatures(org.id)).statsQa;
  const recentHistory = statsOn ? await loadRecentHistory(org.id) : null;
  const fullContext = recentHistory
    ? `${matchContext}\n\n${formatRecentHistoryBlock(recentHistory)}`
    : matchContext;

  const historyBlock = input.history.length
    ? input.history
        .slice(-10)
        .map(
          (h) =>
            `  [${h.timestamp.toISOString().slice(11, 16)}] ${h.authorName ?? "?"}: ${h.body.slice(0, 300)}`,
        )
        .join("\n")
    : "  (no recent context)";

  const messagesBlock = input.messages
    .map((m) => {
      return [
        `- waMessageId: ${m.waMessageId}`,
        `  from: ${m.authorName ?? m.authorPhone ?? "?"}`,
        `  timestamp: ${m.timestamp.toISOString()}`,
        `  body: ${JSON.stringify(m.body.slice(0, 800))}`,
      ].join("\n");
    })
    .join("\n");

  // Current wall-clock in Europe/London — the LLM needs this to
  // resolve relative reminder phrasing ("on Monday", "tomorrow
  // night") to an absolute calendar date. Lives in the FRESH block
  // (not the cached prefix) because it changes every call.
  const nowLondon = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  const freshBlock = [
    `## Current time`,
    `  ${nowLondon} (Europe/London). Use this + each message's \`timestamp\` to resolve relative reminder times.`,
    ``,
    `## Recent chat history (last messages, oldest first)`,
    historyBlock,
    ``,
    `## Messages to classify (batch)`,
    messagesBlock,
    ``,
    `Return JSON with a verdict for every waMessageId above.`,
  ].join("\n");

  const anthropic = getAnthropic();
  if (!anthropic) {
    return input.messages.map((m) => offlineVerdict(m.waMessageId, "ANTHROPIC_API_KEY not set"));
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      // max_tokens: 16384 — much higher than any realistic batch needs
      // (a verbose 10-msg batch is ~3-5K tokens output), so truncation
      // is no longer a failure mode. NOT 64000 (Sonnet 4.5's actual max)
      // because the Anthropic SDK refuses non-streaming calls whose
      // implied runtime > 10 min, which 64000 trips. Lesson learned the
      // hard way 2026-05-26: setting max_tokens to the model max
      // tanked the whole analyzer for ~30 min until detected.
      max_tokens: 16384,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // 1-hour cache — the system prompt never changes, so we pay
          // the higher 2× write cost once and read cheaply from then on.
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: fullContext,
              // Match/squad context + Recent History both only change
              // when attendance/MoM/match-status changes; 1-hour cache
              // absorbs their cost. On DB writes the cache keyed on
              // the content hash naturally invalidates and rebuilds.
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
            {
              type: "text",
              text: freshBlock,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!textBlock) {
      return input.messages.map((m) => offlineVerdict(m.waMessageId, "No text in Claude response"));
    }
    let verdicts = normaliseBatch(textBlock.text, input.messages);

    // ── Auto re-prompt for missing IDs (added 2026-05-26) ──
    // Even with max_tokens at the model max, Sonnet occasionally
    // drops verdicts (JSON malformation, model just skips one,
    // etc.). For those rare cases, do ONE focused retry with just
    // the missing IDs and a minimal prompt (no Recent History,
    // smaller batch → much higher chance of full coverage). If
    // re-prompt still doesn't recover a verdict, the placeholder
    // stays and the analyze route's admin-DM fires.
    const missingIds = verdicts
      .filter((v) => v.reasoning === "Claude emitted no verdict for this id")
      .map((v) => v.waMessageId);
    if (missingIds.length > 0) {
      const missingMsgs = input.messages.filter((m) => missingIds.includes(m.waMessageId));
      const retryMessagesBlock = missingMsgs
        .map((m) => [
          `- waMessageId: ${m.waMessageId}`,
          `  from: ${m.authorName ?? m.authorPhone ?? "?"}`,
          `  timestamp: ${m.timestamp.toISOString()}`,
          `  body: ${JSON.stringify(m.body.slice(0, 800))}`,
        ].join("\n"))
        .join("\n");
      const retryFresh = [
        `## Retry — your previous response omitted verdicts for these waMessageIds. Emit EXACTLY one verdict per id, in the same JSON shape as before.`,
        ``,
        `## Current time`,
        `  ${nowLondon} (Europe/London).`,
        ``,
        `## Messages to classify`,
        retryMessagesBlock,
      ].join("\n");
      try {
        const retryResp = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 64000,
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
          messages: [{ role: "user", content: retryFresh }],
        });
        const retryText = retryResp.content.find(
          (b): b is Anthropic.TextBlock => b.type === "text",
        );
        if (retryText) {
          const retryVerdicts = normaliseBatch(retryText.text, missingMsgs);
          // Merge: any retry verdict whose reasoning is NOT the
          // placeholder replaces the original placeholder.
          const retryById = new Map(retryVerdicts.map((v) => [v.waMessageId, v]));
          verdicts = verdicts.map((v) => {
            if (v.reasoning !== "Claude emitted no verdict for this id") return v;
            const r = retryById.get(v.waMessageId);
            return r && r.reasoning !== "Claude emitted no verdict for this id" ? r : v;
          });
          const stillMissing = verdicts.filter(
            (v) => v.reasoning === "Claude emitted no verdict for this id",
          ).length;
          console.log(
            `[analyzer] re-prompt recovered ${missingIds.length - stillMissing}/${missingIds.length} dropped verdict(s)` +
              (stillMissing > 0 ? ` (${stillMissing} still missing — admin DM will fire)` : ""),
          );
        }
      } catch (err) {
        console.error("[analyzer] re-prompt failed:", err);
        // Fall through — original placeholders remain, admin DM fires.
      }
    }

    return verdicts;
  } catch (err) {
    console.error("[analyzer] Claude call failed:", err);
    const reason = `Claude API error: ${err instanceof Error ? err.message : String(err)}`;
    return input.messages.map((m) => offlineVerdict(m.waMessageId, reason));
  }
}

// ─── LLM-composed scheduled chase messages ──────────────────────────
//
// The bot scheduler decides WHEN to chase (17:00 daily roll-call,
// match-day morning 8-9am, 3-4h before kickoff, 2h pre-kickoff). This
// function composes the TEXT for a chase using the same Match Context
// + squad-state reply rules the reactive analyser uses — so the
// scheduled posts get the same rich roster / tentative / dropped
// summary as the reactive ones.
//
// Returns the message text ready to send to WhatsApp. If Claude fails
// for any reason, returns `null` and the scheduler falls back to the
// static text it used to emit.

export type ChaseKind =
  | "daily-in-list" // 17:00, roster + need-X-more
  | "match-day-morning" // match day 8-9am, upbeat nudge
  | "chase-pre-kickoff" // 3-4h before kickoff, sharper call
  | "pre-kickoff-full" // 2h before, final line-up post (may or may not be short)
  | "pre-kickoff-short"; // 2h before, short-squad variant (last-chance plea)

export async function composeChaseText(input: {
  groupId: string;
  kind: ChaseKind;
}): Promise<string | null> {
  const anthropic = getAnthropic();
  if (!anthropic) return null;

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: input.groupId },
    select: { id: true, name: true },
  });
  if (!org) return null;

  const match = await db.match.findFirst({
    where: {
      activity: { orgId: org.id },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: new Date() },
    },
    include: {
      activity: {
        select: {
          name: true,
          venue: true,
          sport: { select: { name: true, playersPerTeam: true } },
        },
      },
      attendances: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });
  if (!match) return null;

  // Reuse the alternatives query from analyzeBatch.
  const alternatives: Array<{ sportName: string; totalPlayers: number }> = [];
  const family = match.activity.sport.name.split(" ")[0];
  const currentPpt = match.activity.sport.playersPerTeam;
  const siblingActivities = await db.activity.findMany({
    where: { orgId: org.id },
    include: { sport: { select: { name: true, playersPerTeam: true } } },
  });
  const seen = new Set<string>();
  for (const a of siblingActivities) {
    if (a.sport.name.split(" ")[0] !== family) continue;
    if (a.sport.playersPerTeam >= currentPpt) continue;
    if (seen.has(a.sport.name)) continue;
    seen.add(a.sport.name);
    alternatives.push({
      sportName: a.sport.name,
      totalPlayers: a.sport.playersPerTeam * 2,
    });
  }
  alternatives.sort((x, y) => y.totalPlayers - x.totalPlayers);

  const matchContext = buildMatchContextBlock({
    orgName: org.name,
    match,
    alternatives,
  });

  const composePrompt = buildChaseComposePrompt(input.kind);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 64000,
      system: [
        {
          type: "text",
          text: CHASE_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: matchContext,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
            {
              type: "text",
              text: composePrompt,
            },
          ],
        },
      ],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    const raw = textBlock?.text?.trim();
    if (!raw) return null;
    // Strip any accidental fences / leading labels.
    const cleaned = raw
      .replace(/^```(?:text|markdown)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    // Defence-in-depth: even with "Use roster header: ..." in the Match
    // Context, the LLM sometimes still writes "*Playing tonight:*" out
    // of habit. Rewrite any "*Playing <anything>:*" header AND any loose
    // "tonight"/"this evening" in the lead text to match the actual
    // proximity. Regex is narrow: it only fires when we're confident
    // the LLM got it wrong.
    return enforceProximity(cleaned, match.date);
  } catch (err) {
    console.error("[analyzer] composeChaseText Claude call failed:", err);
    return null;
  }
}

/** YYYY-MM-DD key in London time. Used for calendar-day proximity. */
function londonDateKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts; // en-CA formats as YYYY-MM-DD
}

function computeProximity(date: Date): {
  proximity: "past" | "tonight" | "tomorrow" | "this-week" | "future";
  rosterHeader: string;
  friendlyDay: string; // "tonight" | "tomorrow" | "on Tue 28 Apr"
} {
  const hoursToKickoff = (date.getTime() - Date.now()) / (1000 * 60 * 60);
  const kickoffLocal = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/,/g, "");
  const dayPart = kickoffLocal.split(" at ")[0];

  // Proximity bucket is calendar-day based, not raw hours: "tonight"
  // means the match is later today (London), "tomorrow" means
  // calendar-tomorrow, etc. Hours-only thresholds got it wrong at
  // 14:26 BST on match day (>6h to 21:30 → bucketed as "tomorrow"
  // even though the match was that same evening).
  const todayKey = londonDateKey(new Date());
  const matchDayKey = londonDateKey(date);
  const oneDayLaterKey = londonDateKey(
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  );
  const sevenDaysLaterKey = londonDateKey(
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  );
  let proximity: "past" | "tonight" | "tomorrow" | "this-week" | "future";
  if (hoursToKickoff < 0) {
    proximity = "past";
  } else if (matchDayKey === todayKey) {
    proximity = "tonight";
  } else if (matchDayKey === oneDayLaterKey) {
    proximity = "tomorrow";
  } else if (matchDayKey <= sevenDaysLaterKey) {
    proximity = "this-week";
  } else {
    proximity = "future";
  }
  const rosterHeader = {
    past: "*Squad:*",
    tonight: "*Playing tonight:*",
    tomorrow: "*Playing tomorrow:*",
    "this-week": `*Playing ${dayPart}:*`,
    future: `*Playing ${dayPart}:*`,
  }[proximity];
  const friendlyDay = {
    past: `on ${dayPart}`,
    tonight: "tonight",
    tomorrow: "tomorrow",
    "this-week": `on ${dayPart}`,
    future: `on ${dayPart}`,
  }[proximity];
  return { proximity, rosterHeader, friendlyDay };
}

/**
 * Post-process an LLM-composed chase message to guarantee it doesn't
 * say "tonight" when the match is days away (or vice versa).
 *
 *   - Replaces any "*Playing <word>:*" header with the correct one.
 *   - Rewrites loose "tonight"/"this evening" in the lead text to the
 *     friendly day form when proximity isn't tonight. Leaves "tomorrow"
 *     alone unless proximity is further out.
 */
export function enforceProximity(text: string, matchDate: Date): string {
  const { proximity, rosterHeader, friendlyDay } = computeProximity(matchDate);

  // Swap any "*Playing …:*" roster header to the correct one.
  let out = text.replace(/\*Playing [^*\n]+?:\*/gi, rosterHeader);
  // If that didn't match, also try a variant without asterisks (in case
  // the LLM returned plain-text header).
  if (!out.includes(rosterHeader)) {
    out = out.replace(/Playing (tonight|tomorrow|this (?:evening|week))\s*:/i, rosterHeader);
  }

  if (proximity !== "tonight") {
    // Replace "tonight" / "this evening" with friendly-day phrasing
    // ONLY in the lead text (not inside the roster itself, which
    // shouldn't contain either word at this point).
    out = out.replace(/\btonight\b/gi, friendlyDay);
    out = out.replace(/\bthis evening\b/gi, friendlyDay);
  }
  if (proximity !== "tomorrow" && proximity !== "tonight") {
    out = out.replace(/\btomorrow\b/gi, friendlyDay);
  }

  // Catch "off-by-1h" mistakes in HH:MM times. The LLM occasionally
  // outputs the UTC offset (20:30) when it should output the London
  // wall-clock (21:30) — usually because it "helpfully" applied the
  // timezone offset itself. Replace the UTC HH:MM with the London one.
  const londonHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(matchDate);
  const utcHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(matchDate);
  if (londonHm !== utcHm) {
    // Replace bare "20:30" instances (only when followed by non-digit
    // boundary so we don't mangle other numbers).
    out = out.replace(new RegExp(`\\b${utcHm.replace(":", ":")}\\b`, "g"), londonHm);
  }
  return out;
}

/**
 * Replace any LLM-generated numbered roster in a reply with the canonical
 * roster built from the actual Match Context. The LLM has been observed
 * to "helpfully" reorder players (putting late-joiners or provisional
 * members at the bottom) or omit some, despite explicit prompt rules
 * forbidding it. Don't rely on prompt discipline for something this
 * visible — overwrite.
 *
 * Also patches stale "N/M" count claims in the lead text when they
 * disagree with the truth from Match Context.
 *
 * The roster block is detected as 2+ consecutive lines starting with
 * "<digits>." or "<digits>. 🥁". The header line "*Playing …:*" or
 * "*Squad:*" right above is preserved (or rewritten by enforceProximity).
 */
export function enforceCanonicalRoster(
  text: string,
  truth: { confirmed: string[]; maxPlayers: number },
): string {
  // 1. Build the canonical roster lines.
  const rows: string[] = [];
  for (let i = 0; i < truth.maxPlayers; i++) {
    rows.push(
      i < truth.confirmed.length
        ? `${i + 1}. ${truth.confirmed[i]}`
        : `${i + 1}. 🥁`,
    );
  }
  const canonical = rows.join("\n");

  // 2. Find a roster block: 2+ consecutive lines matching "N. ..."
  //    starting from anywhere in the message. Capture the whole run.
  //    Exclude obvious LEADERBOARD blocks — those also use "N. <name>"
  //    numbering but carry stats markers ("— 4/4 (100%)", "— 2 wins",
  //    "— 1042", percent signs, "votes"). Without this exclusion the
  //    post-processor clobbers the bot's own historical-stats replies
  //    with the current squad roster (Kemal flagged 2026-05-14 when
  //    "top 3 most consistent" turned into the upcoming squad list).
  const isLeaderboardLine = (s: string): boolean =>
    /\s—\s/.test(s) || // em-dash separator the leaderboard formatter uses
    /\d+\s*%/.test(s) || // "(96%)"
    /\b(?:wins?|votes?|matches?)\b/i.test(s) || // "2 wins", "5 of 11 votes", "3 matches"
    /\b\d+\/\d+\s*\(/.test(s); // "4/4 (100%)" — attendance pattern
  const lines = text.split("\n");
  let start = -1;
  let end = -1;
  let containsLeaderboardLine = false;
  for (let i = 0; i < lines.length; i++) {
    const isRosterLine = /^\s*\d+\.\s+\S/.test(lines[i]);
    if (isRosterLine) {
      if (start === -1) start = i;
      end = i;
      if (isLeaderboardLine(lines[i])) containsLeaderboardLine = true;
    } else if (start !== -1 && end - start + 1 >= 2) {
      break;
    } else {
      start = -1;
      end = -1;
      containsLeaderboardLine = false;
    }
  }
  let out = text;
  if (start !== -1 && end - start + 1 >= 2 && !containsLeaderboardLine) {
    const before = lines.slice(0, start).join("\n");
    const after = lines.slice(end + 1).join("\n");
    out = [before, canonical, after].filter((s) => s !== "").join("\n");
  }

  // 3. Fix "N/M" count claims to match truth. Only replace when the
  //    denominator matches (so we don't clobber unrelated numbers).
  const realCount = `${truth.confirmed.length}/${truth.maxPlayers}`;
  out = out.replace(
    new RegExp(`\\b\\d+/${truth.maxPlayers}\\b`, "g"),
    realCount,
  );
  // 4. "need N more" claims — recompute from the truth.
  const need = Math.max(0, truth.maxPlayers - truth.confirmed.length);
  out = out.replace(
    /\bneed\s+(?:\*)?\s*\d+\s*(?:\*)?\s+more\b/gi,
    need > 0 ? `need *${need} more*` : "we're full",
  );
  return out;
}

/**
 * Safety net for when the LLM hallucinates that a bench player has
 * been promoted to confirmed ("Aydın moves up from the bench", "Y
 * stepped in", "we're still 14/14"). The actual flow is async — the
 * server queues a PendingBenchConfirmation, DMs the bench player, and
 * only marks them CONFIRMED on their 👍. Until then the squad is
 * genuinely short.
 *
 * Called only when there's an OPEN PendingBenchConfirmation against
 * the relevant match. Strips the false-promotion sentence (heuristic
 * regexes targeting common phrasings) and prepends an honest
 * "Asking <name> to step up..." line (in-group tag, NOT a DM) so the
 * group sees the real status.
 */
export function rewriteOverconfidentPromotion(
  text: string,
  args: {
    benchName: string;
    confirmedCount: number;
    maxPlayers: number;
    /** Current bench attendance count. When 0 there's literally no one
     *  to step up, so don't prepend the "Asking the bench" line — it
     *  reads as delusional ("tagged here with a 👍/👎" when nobody was).
     *  We still strip false "X moves up" phrases the LLM may have
     *  hallucinated. Sutton 2026-05-26: 4 dropped at once on an empty
     *  bench, the open BenchSlotOffers piled "Asking the bench — 10/14"
     *  onto every subsequent unrelated reply for ~11 min until the
     *  format flip cleared them. */
    benchCount: number;
  },
): string {
  const { benchName, confirmedCount, maxPlayers, benchCount } = args;

  // Strip phrases that imply the swap is done. Match per-line so we
  // don't gobble unrelated text on the same line.
  const FALSE_PROMOTION_PATTERNS: RegExp[] = [
    /[^.!?\n]*\bmoves?\s+up\s+from\s+the\s+bench\b[^.!?\n]*[.!?]?/gi,
    /[^.!?\n]*\bsteps?\s+in\s+(?:for|to\s+take|to\s+fill)\b[^.!?\n]*[.!?]?/gi,
    /[^.!?\n]*\bstepped\s+in\b[^.!?\n]*[.!?]?/gi,
    /[^.!?\n]*\btaking\s+(?:the\s+|that\s+)?slot\b[^.!?\n]*[.!?]?/gi,
    /[^.!?\n]*\bis\s+replacing\b[^.!?\n]*[.!?]?/gi,
    /[^.!?\n]*\bcomes\s+(?:up|in)\s+from\s+the\s+bench\b[^.!?\n]*[.!?]?/gi,
    /[^.!?\n]*\bwe(?:'re|\s+are)\s+still\s+\d+\/\d+\b[^.!?\n]*[.!?]?/gi,
  ];
  let stripped = text;
  for (const re of FALSE_PROMOTION_PATTERNS) {
    stripped = stripped.replace(re, "");
  }
  // Collapse the whitespace/punctuation we just punched holes in.
  stripped = stripped
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\.[ ]*\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "");

  // Empty bench → only strip the false claims; don't prepend the
  // "Asking the bench" line, because there's no bench to ask. The
  // LLM's reply will naturally state what's needed (chase the group);
  // we don't override it with a misleading status line.
  if (benchCount === 0) return stripped.trim();

  // Prepend an honest status line above the roster block (or at the
  // top if no roster block detected).
  // NB: the bench prompt is an IN-GROUP @mention (kind:"bench-prompt"
  // posts to the group, not a DM). Saying "in DMs" was misinformation
  // — a bench player who got no DM (Erdal, 2026-05-18) is right to
  // call it out. Word it to match what actually happens: they're
  // tagged in the group with a 👍/👎 prompt.
  const honest = `Asking *${benchName}* to step up — they've been tagged here with a 👍/👎. Squad is *${confirmedCount}/${maxPlayers}* until they confirm.`;

  // Drop the line in just before any "*Playing tonight:*" / "*Squad:*"
  // header, or at the start when there isn't one.
  const headerMatch = stripped.match(/^[ \t]*\*?(Playing|Squad)[^\n]*\*?[ \t]*$/m);
  if (headerMatch?.index !== undefined) {
    stripped =
      stripped.slice(0, headerMatch.index) +
      honest +
      "\n\n" +
      stripped.slice(headerMatch.index);
  } else {
    stripped = honest + "\n\n" + stripped;
  }
  return stripped.trim();
}

const CHASE_SYSTEM_PROMPT = `You are MatchTime, composing a SCHEDULED group message — not a reply to anyone. The bot's scheduler is firing a chase/announcement at a fixed time because the squad is in a certain state.

Output is PLAIN WhatsApp-ready text (no JSON, no markdown fences). Return only the message body — no preamble like "Here's the message:" and no closing commentary.

Use the same style as the reactive replies: WhatsApp-friendly formatting with *bold* via single asterisks, real line breaks, one or two emoji at most. Ground every name in the Match Context — never invent. Use "Kemal" / "Elvin" first names fine; for ambiguous repeats in the group, use fuller names ("Ibrahim Sahin" when needed to disambiguate).

Every chase message MUST end with a numbered roster block. Use the EXACT header from "Use roster header:" in the Match Context — do NOT invent your own. It'll be one of: "*Playing tonight:*" (same-day / within 6h), "*Playing tomorrow:*", or "*Playing <Weekday DD Mon>:*" for anything further out. Getting this wrong (e.g. saying "tonight" 6 days before the match) confuses the group — always use the pre-computed header. The roster has exactly maxPlayers rows; filled slots use names from the Confirmed list in order; any row above confirmedCount is 🥁 (single drum per row).

NEVER write "tonight", "this evening", "tomorrow" or similar temporal references in the LEAD text unless "proximity=" in the Match Context confirms it. For any proximity other than "tonight"/"tomorrow", refer to the match by its day-and-date (e.g. "Tuesday 7-a-side on Tue 28 Apr at 21:30") rather than a vague relative time.

If any player appears in the Dropped list AND the history or chat context suggests they'll still play if nobody replaces them, add a separate line *below* the roster: "Tentative: <Name> (will play if nobody steps in)". Do not put tentative players in a numbered slot.

If an "Alternative formats available" block is in the context AND the squad is short AND kickoff is within 24h AND the smaller format would actually fill, you MAY append one line proposing the switch and naming (from the Confirmed list) who'd go to the bench. Never invent names for the bench overflow.

Tone: the group's tone — casual, terse, no corporate fluff. No emoji soup.`;

function buildChaseComposePrompt(kind: ChaseKind): string {
  const header = "## Chase type";
  switch (kind) {
    case "daily-in-list":
      return [
        header,
        "daily-in-list (17:00 London)",
        "",
        "Purpose: quick squad-state recap so the group sees numbers in the evening.",
        "Open with a one-liner that sets the scene (e.g. '🗓 Quick 5pm update') followed by the lead (who's out / count vs needed). End with the roster block.",
      ].join("\n");
    case "match-day-morning":
      return [
        header,
        "match-day-morning (8-9am London on match day)",
        "",
        "Purpose: upbeat morning nudge while there's still time to fill spots.",
        "Open with something like '☀️ Morning all —' and lead with how many we still need. End with the roster block.",
      ].join("\n");
    case "chase-pre-kickoff":
      return [
        header,
        "chase-pre-kickoff (3-4 hours before kickoff)",
        "",
        "Purpose: sharper call — the window is closing. Lead should convey urgency without panic. Mention kickoff time. End with the roster block.",
      ].join("\n");
    case "pre-kickoff-full":
      return [
        header,
        "pre-kickoff-full (2 hours before kickoff, squad is FULL)",
        "",
        "Purpose: final check-in — see-you-there vibe. Lead with kickoff time + venue + 'X/Y confirmed' (should be X = maxPlayers). End with the roster block.",
      ].join("\n");
    case "pre-kickoff-short":
      return [
        header,
        "pre-kickoff-short (2 hours before kickoff, squad is SHORT)",
        "",
        "Purpose: last-chance plea — squad still not full and we're 2h out. Lead with kickoff time + venue + count. Explicit 'last chance to jump in' line. If a format switch is viable, propose it. End with the roster block.",
      ].join("\n");
  }
}

function offlineVerdict(waMessageId: string, reason: string): AnalysisVerdict {
  return {
    waMessageId,
    intent: "unclear",
    confidence: 0,
    react: null,
    reply: null,
    registerAttendance: null,
    benchConfirmation: null,
    scoreRed: null,
    scoreYellow: null,
    includeNames: null,
    teamOverrides: null,
    bulkPayment: null,
    reminder: null,
    registerFor: null,
    reasoning: reason,
  };
}

function safeParseJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const v = JSON.parse(cleaned);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normaliseBatch(text: string, messages: BatchInputMessage[]): AnalysisVerdict[] {
  const parsed = safeParseJson(text);
  const verdictsRaw = Array.isArray((parsed as { verdicts?: unknown })?.verdicts)
    ? ((parsed as { verdicts: unknown[] }).verdicts as unknown[])
    : [];

  const byId = new Map<string, AnalysisVerdict>();
  for (const v of verdictsRaw) {
    if (typeof v !== "object" || v === null) continue;
    const obj = v as Record<string, unknown>;
    const waMessageId = typeof obj.waMessageId === "string" ? obj.waMessageId : null;
    if (!waMessageId) continue;
    byId.set(waMessageId, normaliseVerdict(waMessageId, obj));
  }

  return messages.map((m) => {
    const verdict = byId.get(m.waMessageId);
    if (verdict) return verdict;
    // Claude didn't emit a verdict for this message — treat as unclear
    // so we still record it as handled (no re-analysis later).
    return offlineVerdict(m.waMessageId, "Claude emitted no verdict for this id");
  });
}

function normaliseVerdict(waMessageId: string, raw: Record<string, unknown>): AnalysisVerdict {
  const VALID_INTENTS: AnalysisIntent[] = [
    "in",
    "out",
    "replacement_request",
    "conditional_in",
    "question",
    "score",
    "generate_teams_request",
    "bring_guests_vague",
    "bulk_payment_credit",
    "reminder_request",
    "noise",
    "unclear",
  ];
  const intent = VALID_INTENTS.includes(raw.intent as AnalysisIntent)
    ? (raw.intent as AnalysisIntent)
    : "unclear";

  const confidence =
    typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  const react =
    typeof raw.react === "string" && raw.react.trim().length > 0 ? raw.react.trim() : null;
  const reply =
    typeof raw.reply === "string" && raw.reply.trim().length > 0 ? raw.reply.trim() : null;
  const registerAttendance =
    raw.registerAttendance === "IN" ||
    raw.registerAttendance === "OUT" ||
    raw.registerAttendance === "BENCH"
      ? raw.registerAttendance
      : null;
  const benchConfirmation =
    raw.benchConfirmation === "yes" || raw.benchConfirmation === "no"
      ? raw.benchConfirmation
      : null;
  const scoreRed =
    typeof raw.scoreRed === "number" && Number.isFinite(raw.scoreRed) && raw.scoreRed >= 0
      ? Math.min(99, Math.round(raw.scoreRed))
      : null;
  const scoreYellow =
    typeof raw.scoreYellow === "number" && Number.isFinite(raw.scoreYellow) && raw.scoreYellow >= 0
      ? Math.min(99, Math.round(raw.scoreYellow))
      : null;
  const includeNames =
    Array.isArray(raw.includeNames)
      ? (raw.includeNames as unknown[])
          .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
          .map((n) => n.trim())
      : null;
  const teamOverrides = Array.isArray(raw.teamOverrides)
    ? (raw.teamOverrides as unknown[])
        .map((e) => {
          if (!e || typeof e !== "object") return null;
          const o = e as Record<string, unknown>;
          const name = typeof o.name === "string" ? o.name.trim() : "";
          const team = o.team === "RED" || o.team === "YELLOW" ? o.team : null;
          if (!name || !team) return null;
          return { name, team };
        })
        .filter((e): e is { name: string; team: "RED" | "YELLOW" } => e !== null)
    : null;
  const registerFor = Array.isArray(raw.registerFor)
    ? (raw.registerFor as unknown[])
        .map((e) => {
          if (!e || typeof e !== "object") return null;
          const o = e as Record<string, unknown>;
          const name = typeof o.name === "string" ? o.name.trim() : "";
          const action = o.action === "IN" || o.action === "OUT" ? o.action : null;
          if (!name || !action) return null;
          return { name, action };
        })
        .filter((e): e is { name: string; action: "IN" | "OUT" } => e !== null)
    : null;
  let bulkPayment: AnalysisVerdict["bulkPayment"] = null;
  if (raw.bulkPayment && typeof raw.bulkPayment === "object") {
    const bp = raw.bulkPayment as Record<string, unknown>;
    const payerName = typeof bp.payerName === "string" ? bp.payerName.trim() : "";
    const count = typeof bp.count === "number" ? Math.round(bp.count) : 0;
    if (payerName && count >= 1 && count <= 50) {
      const coveredNames = Array.isArray(bp.coveredNames)
        ? (bp.coveredNames as unknown[])
            .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
            .map((n) => n.trim())
        : undefined;
      bulkPayment = {
        payerName,
        count,
        coveredNames: coveredNames && coveredNames.length > 0 ? coveredNames : undefined,
      };
    }
  }
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";

  // ── reminder (intent: reminder_request) ──────────────────────────
  // Validate shape only; the SERVER owns the London→UTC conversion and
  // future/window clamping (see analyze route). We just sanity-check
  // the date is YYYY-MM-DD and time (if present) is HH:MM.
  let reminder: AnalysisVerdict["reminder"] = null;
  if (raw.reminder && typeof raw.reminder === "object") {
    const r = raw.reminder as Record<string, unknown>;
    const date = typeof r.date === "string" ? r.date.trim() : "";
    const time = typeof r.time === "string" ? r.time.trim() : "";
    const note = typeof r.note === "string" ? r.note.trim() : "";
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const timeOk = time === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
    if (dateOk && timeOk && note.length > 0) {
      reminder = {
        date,
        time: time === "" ? undefined : time,
        note: note.slice(0, 300),
      };
    }
  }

  // Low-confidence downgrade: wipe all actions so the bot stays silent.
  if (confidence < 0.7 && intent !== "noise") {
    return {
      waMessageId,
      intent: "unclear",
      confidence,
      react: null,
      reply: null,
      registerAttendance: null,
      benchConfirmation: null,
      scoreRed: null,
      scoreYellow: null,
      includeNames: null,
      teamOverrides: null,
      bulkPayment: null,
      reminder: null,
      registerFor: null,
      reasoning: `[low-confidence downgrade] ${reasoning}`,
    };
  }

  return {
    waMessageId,
    intent,
    confidence,
    react,
    reply,
    registerAttendance,
    benchConfirmation,
    scoreRed,
    scoreYellow,
    includeNames,
    teamOverrides: teamOverrides && teamOverrides.length > 0 ? teamOverrides : null,
    bulkPayment,
    reminder,
    registerFor: registerFor && registerFor.length > 0 ? registerFor : null,
    reasoning,
  };
}

// ─── Back-compat shim ─────────────────────────────────────────────────
// Legacy single-message API used by early scripts and as a fallback. Now
// implemented as a batch of size 1 so all paths route through the same
// analyzer.

export interface AnalysisResult {
  intent: AnalysisIntent;
  confidence: number;
  react: string | null;
  reply: string | null;
  registerAttendance: "IN" | "OUT" | "BENCH" | null;
  scoreRed: number | null;
  scoreYellow: number | null;
  includeNames: string[] | null;
  reasoning: string;
}

export interface AnalysisInput {
  groupId: string;
  message: {
    body: string;
    authorPhone: string;
    authorName: string | null;
    authorUserId: string | null;
    waMessageId: string;
    timestamp: Date;
  };
  history: BatchInputHistory[];
}

export async function analyzeMessage(input: AnalysisInput): Promise<AnalysisResult> {
  const verdicts = await analyzeBatch({
    groupId: input.groupId,
    history: input.history,
    messages: [
      {
        waMessageId: input.message.waMessageId,
        body: input.message.body,
        authorPhone: input.message.authorPhone,
        authorName: input.message.authorName,
        authorUserId: input.message.authorUserId,
        timestamp: input.message.timestamp,
      },
    ],
  });
  const v = verdicts[0];
  return {
    intent: v.intent,
    confidence: v.confidence,
    react: v.react,
    reply: v.reply,
    registerAttendance: v.registerAttendance,
    scoreRed: v.scoreRed,
    scoreYellow: v.scoreYellow,
    includeNames: v.includeNames,
    reasoning: v.reasoning,
  };
}
