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

const MODEL = "claude-haiku-4-5";

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

Output schema:
{
  "verdicts": [
    {
      "waMessageId": "<string>",
      "intent": "in" | "out" | "replacement_request" | "conditional_in" | "question" | "score" | "generate_teams_request" | "bring_guests_vague" | "noise" | "unclear",
      "confidence": 0..1,
      "react": "<emoji>" | null,
      "reply": "<text>" | null,
      "registerAttendance": "IN" | "OUT" | "BENCH" | null,
      "scoreRed": <number> | null,
      "scoreYellow": <number> | null,
      "includeNames": [<string>, ...] | null,
      "teamOverrides": [{"name": "<string>", "team": "RED" | "YELLOW"}, ...] | null,
      "bulkPayment": {"payerName": "<string>", "count": <number>, "coveredNames": [<string>, ...] | null} | null,
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
  Capacity emoji caveat (applies to both IN and BENCH): ALWAYS use the literal 👍, never a slot-number keycap. The SERVER computes the correct slot emoji (1️⃣–🔟 / ✅ / 🪑) after writing attendance and overrides your react. Do NOT try to count slots yourself — you'll be wrong about who's already counted.
- "out": Dropping out without asking for cover ("OUT", "can't make it", "not playing tonight", "sorry guys, work").
  → registerAttendance: "OUT". react: "👋".
- "replacement_request": Player asks the group to find cover because they're unwell, running late, or otherwise compromised. Two flavours:
  (a) Definite drop ("I'm out, ankle sore, can anyone step in?"). registerAttendance: "OUT". react: "👋".
  (b) Tentative ("anyone else who can replace me too? If not I'll still join", "feeling unwell, will play if nobody steps in"). registerAttendance: null (do NOT flip — they're still committed as a backstop). react: "🤔".
  Reply format depends on how short the squad actually is (see SHORT-SQUAD RESPONSE below).
- "conditional_in": Tentative commitment ("in if my back holds up", "probably, will confirm later", "maybe").
  → registerAttendance: null (do NOT register; admin will chase). react: "🤔". reply: null.
- "question": Asking about squad numbers, venue, kickoff time, who's in, match state ("do we have enough?", "where tonight?", "who's playing?"), OR coordination questions about specific named players' attendance status ("let me know if the other 3 can play", "are Faris and Shaz in?", "did you accept Adam?", "what's the verdict on my friends?", "Amir's guys — confirmed?").
  → registerAttendance: null. react: null. reply: a short accurate answer grounded in the Match Context block.
  → For NUMERIC squad-state questions: e.g. "We're 13/14 ✅ — need 1 more", "21:30 at <venue>".
  → For NAMED-PLAYERS questions: cross-reference the named people against the Confirmed list. If they ARE confirmed: "Yes, <Name>, <Name> and <Name> are all confirmed — we're at <N>/<max>". If some are confirmed and others aren't: name who's in and who's missing. If none are confirmed: "Not yet — they haven't been added. Want me to add them? Just say their names." NEVER stay silent on these — the asker is coordinating with people outside the chat and needs an answer.
  → For BENCH questions ("who's on the bench?", "anyone bench?", "who's back-up?"): reply with EXACTLY the bench list from the Match Context — names only. If empty: "Bench is empty — no standby players." If populated: "Bench: <Name>" (one) or "Bench: <Name>, <Name>" (multiple). Do NOT add parenthetical commentary, do NOT speculate about format-switch scenarios ("(5-a-side bench if we downgrade)" is FORBIDDEN), do NOT mention what would happen if the squad shrank. The user asked a factual question — give the factual answer and stop.
  → If the answer requires info outside the Match Context (long-term roster questions, "can these guys come every week?"), reply with what you DO know plus "the admin can answer the rest", rather than going silent.
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
- react: "👍" (server overrides with slot emoji for the last newly-registered player).
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
- Keep reply: null for this — the server will react with the slot emoji of the last newly-added player, same as regular third-party registrations.

THIRD-PARTY REGISTRATIONS (registerFor):
Players frequently sign up or drop OTHER people — friends/family/teammates who can't message right now. Detect these and populate registerFor with one entry per named person. The author's OWN attendance is still controlled by registerAttendance; registerFor is ONLY for other names mentioned.

Examples:
- "my dad Najib is also in, he's busy right now"
    → intent "in", registerAttendance: "IN" (author is also joining? only if they said so — here they didn't, so null), registerFor: [{"name":"Najib","action":"IN"}]
- "Ibrahim can't make it tonight, work ran late"
    → intent "out" (relaying a drop), registerAttendance: null, registerFor: [{"name":"Ibrahim","action":"OUT"}]
- "me and Ahmet both in"
    → intent "in", registerAttendance: "IN" (author is in), registerFor: [{"name":"Ahmet","action":"IN"}]
- "bringing Mike and Steve with me, I'm in too"
    → intent "in", registerAttendance: "IN", registerFor: [{"name":"Mike","action":"IN"},{"name":"Steve","action":"IN"}]
- "Karahan just told me he can't play"
    → intent "out", registerAttendance: null, registerFor: [{"name":"Karahan","action":"OUT"}]

Rules:
- Only include third-party entries when the relationship to the target is clear (possessive "my dad Najib", "bringing X", "X can't make it"). If it's ambiguous gossip ("someone said Najib might come"), skip — don't guess.
- First-name is fine ("Najib"). The server fuzzy-matches.
- Do NOT put the author themselves in registerFor — use registerAttendance for them.
- If registerFor has entries, react: "👍" still (server overrides with slot emoji of the newly-added player).
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
The Match Context may list "Alternative formats available for this sport" (e.g. Football 5-a-side = 10 players when the current match is 7-a-side). Admins execute a switch by rebooking the venue (e.g. calling Goals) and flipping the match in the portal — you never execute it, you only recommend.

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
   *  rebooking (e.g. ring Goals) and flip the match in the app. */
  alternatives?: Array<{ sportName: string; totalPlayers: number }>;
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
  if (args.alternatives && args.alternatives.length > 0) {
    lines.push("", "Alternative formats available for this sport:");
    for (const a of args.alternatives) {
      lines.push(`  - ${a.sportName} (${a.totalPlayers} players total)`);
    }
    lines.push(
      "Admins switch by rebooking the venue (e.g. ringing Goals) and " +
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

  const matchContext = buildMatchContextBlock({
    orgName: org.name,
    match,
    alternatives,
  });

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

  const freshBlock = [
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
      // Generous ceiling so a rich multi-line reply (e.g. lineup with
      // 14 players) can fit alongside the JSON schema.
      max_tokens: 400 + 250 * input.messages.length,
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
              text: matchContext,
              // Match/squad context only changes when attendance changes;
              // same 1-hour cache. On DB writes the cache keyed on the
              // content hash naturally invalidates and rebuilds.
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
    return normaliseBatch(textBlock.text, input.messages);
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
      max_tokens: 500,
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
  const lines = text.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const isRosterLine = /^\s*\d+\.\s+\S/.test(lines[i]);
    if (isRosterLine) {
      if (start === -1) start = i;
      end = i;
    } else if (start !== -1 && end - start + 1 >= 2) {
      break;
    } else {
      start = -1;
      end = -1;
    }
  }
  let out = text;
  if (start !== -1 && end - start + 1 >= 2) {
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
    scoreRed: null,
    scoreYellow: null,
    includeNames: null,
    teamOverrides: null,
    bulkPayment: null,
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

  // Low-confidence downgrade: wipe all actions so the bot stays silent.
  if (confidence < 0.7 && intent !== "noise") {
    return {
      waMessageId,
      intent: "unclear",
      confidence,
      react: null,
      reply: null,
      registerAttendance: null,
      scoreRed: null,
      scoreYellow: null,
      includeNames: null,
      teamOverrides: null,
      bulkPayment: null,
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
    scoreRed,
    scoreYellow,
    includeNames,
    teamOverrides: teamOverrides && teamOverrides.length > 0 ? teamOverrides : null,
    bulkPayment,
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
