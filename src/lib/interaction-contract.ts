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
