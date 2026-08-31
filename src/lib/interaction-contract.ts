/**
 * INTERACTION CONTRACT — the deterministic gate that decides whether
 * MatchTime is allowed to ACT on / ANSWER a group message.
 *
 * GUIDING PRINCIPLE: "LLM extracts, code decides." The LLM classifies
 * intent; THIS code decides whether MT may act, based on a simple,
 * predictable contract:
 *
 *   ACT WITHOUT A TAG only for a player's OWN clear self-attendance
 *   (intent in/out with registerAttendance for the SELF sender, no
 *   third-party registerFor). Plus the separate, tag-free admin
 *   squad-from-list pipeline (cron/archive driven — not handled here).
 *
 *   REQUIRE an @Match Time tag for everything else MT could DO or
 *   ANSWER: questions, team ops (generate/show), stats requests, moving/
 *   benching/replacing OTHER players, reminders, payment queries, etc.
 *   Untagged → noise: no action, no reply, no reaction, DB unchanged.
 *
 * MT must be CONSERVATIVE and PREDICTABLE: act only when clearly
 * warranted, stay silent on banter.
 */

export interface TagInput {
  body: string;
  /** Structured signal forwarded by the Pi: did this message @-mention
   *  the bot's own JID? PRIMARY tag signal. `undefined` when an older Pi
   *  build didn't send it → fall back to text matching. */
  botMentioned?: boolean;
}

/**
 * Did this message tag @Match Time?
 *
 *  - PRIMARY:  msg.botMentioned === true — the Pi matched the bot inside
 *              the message's mention list. Authoritative when true.
 *  - FALLBACK: an explicit textual bot tag in the body. This runs whenever
 *              the structured signal is NOT a positive true — i.e. when
 *              botMentioned is `false` OR `undefined`.
 *
 * HARDENED (prod incident 2026-06-29): a `false` botMentioned NO LONGER
 * suppresses a clear text tag. Root cause was a Pi-side @lid-vs-@c.us
 * self-mention bug that reported botMentioned:false for a genuinely-tagged
 * admin command ("@Match Time Kieran and Rashad are IN"), so the gate
 * silently dropped a real action. Since the Pi rewrites a bot @-mention
 * into the literal "@Match Time" in the body, the text tag is a reliable
 * second signal that survives a structured-signal regression. The
 * false-positive risk (casual "match time" banter) is the same tradeoff
 * already accepted for the undefined-fallback path, and we lean toward the
 * hardened fallback because dropping a real admin action is the worse error.
 */
export function messageTagsBot(msg: TagInput): boolean {
  if (msg.botMentioned === true) return true;
  const body = msg.body ?? "";
  return (
    /@?\s*match\s*time\b/i.test(body) ||
    /\bmatchtime\b/i.test(body) ||
    /@mt\b/i.test(body)
  );
}

export interface GateRegisterForEntry {
  name: string;
  action: "IN" | "OUT" | "BENCH";
}

export interface GateVerdict {
  intent: string;
  registerAttendance: "IN" | "OUT" | "BENCH" | null;
  registerFor: GateRegisterForEntry[] | null;
}

/**
 * Is this verdict PURELY the sender's own attendance (the only tag-free
 * action class)? True when:
 *   - the intent is a self-attendance intent (in / out / conditional_in /
 *     replacement_request — a player speaking about THEIR OWN slot), AND
 *   - there is NO third-party registerFor (moving/benching/replacing
 *     someone else is a directed op that REQUIRES a tag).
 *
 * We deliberately DON'T require registerAttendance to be populated: a bare
 * intent:"in" whose registerAttendance the server backfills later is still
 * self-attendance. A self-attendance intent that ALSO carries a
 * registerFor for another player is a directed op → not pure self.
 */
export function isSelfAttendanceVerdict(v: GateVerdict): boolean {
  const SELF_ATTENDANCE_INTENTS = new Set([
    "in",
    "out",
    "conditional_in",
    "replacement_request",
  ]);
  if (!SELF_ATTENDANCE_INTENTS.has(v.intent)) return false;
  const movesOthers = !!(v.registerFor && v.registerFor.length > 0);
  return !movesOthers;
}

/**
 * Does acting on this verdict REQUIRE an @Match Time tag?
 *
 * No when it's pure self-attendance (the one tag-free action class).
 * No when there's nothing to do (noise/unclear with no writes) — there's
 * no action to gate, so the tag is irrelevant; the existing noise path
 * already keeps MT silent.
 * No for a third-party registerFor that ONLY ADDS named players (every
 * entry is an "IN") — registering a friend someone names in natural group
 * chat ("Add Rashad please", "my mate Kieran's in") is now tag-free. The
 * upstream LLM confidence + hypothetical/future seatbelts still gate WHEN
 * an add is emitted; this just removes the tag requirement for it.
 * Yes for everything else action/answer-y: questions, team ops, reminders,
 * payment, score handling, and any third-party registerFor that DROPS,
 * BENCHES, or SWAPS OUT another player (any non-IN entry) — removing or
 * moving someone who never consented stays an explicit, tagged op.
 */
export function actionRequiresTag(v: GateVerdict): boolean {
  if (isSelfAttendanceVerdict(v)) return false;

  const entries = v.registerFor ?? [];
  if (entries.length > 0) {
    // IN-only adds → tag-free. Any OUT/BENCH (a drop, demote, or the OUT
    // half of a swap) → still requires a tag.
    return entries.some((e) => e.action !== "IN");
  }

  // Action/answer-y intents MT performs in the group, all of which
  // require an explicit @Match Time tag. NOTE: "score" is deliberately
  // EXCLUDED — a match-result report ("we won 5-2") is a genuine state
  // change MT records (feeds MoM/ratings), closer to self-attendance than
  // to an answer; it stays tag-free (and is separately permission-gated
  // to participants/admins by the score path).
  //
  // "bring_guests_vague" stays listed as a BACKSTOP only. The analyze
  // route peels every unnamed-guest offer off BEFORE this gate (see the
  // UNNAMED-GUEST NAME ASK block in api/whatsapp/analyze/route.ts) and
  // decides it with shouldAskForGuestName in lib/guest-name-ask.ts —
  // the one tag-free thing MT may SAY rather than DO.
  //
  // Why that is a narrow exception and not a hole in the contract
  // (Kemal, 2026-08-31): nobody has been named, so the branch is
  // structurally incapable of writing attendance — its blast radius is
  // one sentence. Against that, staying silent cost the owner a manual
  // "yes pls, can you share the name?" for a guest who was being
  // offered to him. The chattiness the contract exists to prevent is
  // held back by four separate gates in shouldAskForGuestName: the
  // message must READ as an offer (not banter that mentions a mate),
  // the squad must actually have room, the sender must be a resolved
  // member, and each player gets AT MOST ONE ask per match, forever.
  // Anything that fails those gets today's silence.
  const ACTIONY_INTENTS = new Set([
    "question",
    "generate_teams_request",
    "show_teams_request",
    "reminder_request",
    "bulk_payment_credit",
    "bring_guests_vague",
  ]);
  if (ACTIONY_INTENTS.has(v.intent)) return true;

  // Anything left (noise, unclear, conditional_in with no write) has no
  // action to gate.
  return false;
}

/**
 * Deterministic seatbelt: does this message look like a HYPOTHETICAL,
 * PAST-TENSE, or CONDITIONAL self-statement that must NEVER be turned
 * into an attendance write — even if the LLM slips and emits one?
 *
 *   "If I was in the team it won't be ruined"  → hypothetical
 *   "I would have been in" / "I would've been in" → hypothetical
 *   "I was in last week"                        → past tense
 *
 * Kept tight so a plain present-tense "I'm in" / "in" never trips it.
 */
export function looksLikeHypotheticalOrPast(body: string): boolean {
  const t = (body ?? "").toLowerCase();

  // Hypothetical: "if I was/were in", "if I'd be in", "if I was playing".
  if (/\bif\s+i\s+(was|were|wuz|am|'?d|would)\b/.test(t)) return true;

  // Counterfactual: "I would('ve)/I'd have been in", "would have played".
  if (/\bi\s*(would|'?d)\s*('?ve|\s+have|\s+of)?\s+(been|have|play|join)/.test(t)) return true;
  if (/\bwould\s*('?ve|\s+have|\s+of)\s+(been\s+in|played|joined)/.test(t)) return true;

  // Past tense self-attendance: "I was in", "I was playing" (but NOT
  // "I am in"). Guard against "I was in" being a present claim by
  // requiring the literal past-tense "was/were".
  if (/\bi\s+(was|were)\s+(in|playing|out|down|on)\b/.test(t)) return true;

  return false;
}

/** People a member can offer up who are NOT the member. Deliberately a
 *  closed list of PERSON nouns — "my back", "my car", "my shift" must
 *  never match. */
const THIRD_PARTY_NOUN =
  "brothers?|sisters?|bro|sis|mates?|friends?|cousins?|sons?|dad|father|uncle|nephew|" +
  "colleagues?|boys?|lads?|guys?|pals?|neighbou?rs?|flatmates?|housemates?|team-?mates?|kids?";

/** The message's SUBJECT is someone else: it opens with a possessive
 *  person ("my brother", "Dan's mate", "his cousin"). Leading @mentions
 *  and punctuation are stripped first — the production message was
 *  "@Kemal Ediz my brother can play if needed". */
const THIRD_PARTY_SUBJECT = new RegExp(
  `^(?:my|his|her|their|[a-z][a-z'’-]*'s)\\s+(?:${THIRD_PARTY_NOUN})\\b`,
  "i",
);

/** Any first-person pronoun anywhere — the sender putting THEMSELVES in
 *  the picture ("me and my brother", "my mate and I", "put us down"). */
const FIRST_PERSON = /\b(?:i|me|myself|we|us|our)\b/i;

/** Words that can legitimately OPEN the sentence we're testing, so they
 *  must never be swallowed as part of a leading @mention. */
const SUBJECT_STARTER = /^(?:my|his|her|their|our|i|im|me|we|us)\b/i;

/** Drop leading "@Handle Surname" mentions — the production message was
 *  "@Kemal Ediz my brother can play if needed", and the subject we care
 *  about only starts after them. One capitalised token is consumed per
 *  mention (the surname), never a word that could start the sentence. */
function stripLeadingMentions(raw: string): string {
  const tokens = raw.trim().split(/\s+/);
  let i = 0;
  let afterMention = false;
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.startsWith("@")) {
      afterMention = true;
      i++;
      continue;
    }
    if (afterMention && /^\p{Lu}/u.test(tk) && !SUBJECT_STARTER.test(tk)) {
      afterMention = false;
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i).join(" ");
}

/**
 * Deterministic seatbelt: is this message an offer about a THIRD PARTY
 * playing, with the sender nowhere in it?
 *
 *   "my brother can play if needed"          → true  (the production bug)
 *   "my mate could fill in if you're short"  → true
 *   "me and my brother are both in"          → false (sender included)
 *   "in, my mate's coming too"               → false (sender is the subject)
 *   "I'll be the 14th if you're short"       → false (a real self offer)
 *
 * Callers use it ONLY to strip a self IN/BENCH write the LLM should never
 * have emitted (see the analyze route). It is deliberately narrow on both
 * axes — the third-party phrase must be the SUBJECT of the message, and
 * a single first-person pronoun anywhere disarms it — because wrongly
 * dropping a genuine self-registration is worse than the bug it guards.
 */
export function offerIsAboutSomeoneElse(body: string): boolean {
  const t = stripLeadingMentions(body ?? "")
    // Leading punctuation / emoji, so the real subject lands at index 0.
    .replace(/^[^\p{L}]+/u, "")
    .trim();
  if (!t) return false;
  if (FIRST_PERSON.test(t)) return false;
  return THIRD_PARTY_SUBJECT.test(t);
}
