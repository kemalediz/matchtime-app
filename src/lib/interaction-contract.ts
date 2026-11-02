/**
 * INTERACTION CONTRACT — the deterministic gate that decides whether
 * MatchTime is allowed to ACT on / ANSWER a group message.
 *
 * GUIDING PRINCIPLE: "LLM extracts, code decides." The LLM classifies
 * intent; THIS code decides whether MT may act, based on a simple,
 * predictable contract:
 *
 *   ATTENDANCE NEVER NEEDS A TAG in the players' group (Kemal,
 *   2026-11-02): the sender's own IN, OUT or maybe, and anybody else
 *   added, dropped, benched or replaced. The engine still decides WHO
 *   may do WHAT (the confidence floor, the admin-only bench guard, the
 *   banter corroboration, capacity), but never asks for a tag.
 *
 *   EVERYTHING ELSE MatchTime could DO or ANSWER needs an @Match Time
 *   tag: questions, team ops (generate/show), stats requests,
 *   reminders, payment queries, etc. Untagged, those are noise: no
 *   action, no reply, no reaction, DB unchanged.
 *
 *   History, short: until 2026-11-02 a third-party OUT or BENCH needed a
 *   tag, with named exceptions for an admin's OUT (2026-09-07) and the
 *   leaving half of a stated replacement (2026-09-22). On 2 Nov a
 *   player's untagged "Sorry, Ismayil is out" was refused and Ismayil
 *   stayed on the list; Kemal ruled every attendance message tag-free.
 *
 *   The admin group (HQ) is separate and acts only on a real tag
 *   (`admin-group-understand.ts`); nothing here changes that.
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
  /** Structured signal forwarded by the Pi (2026-10-16): is this message a
   *  WhatsApp reply quoting MatchTime's OWN message? Only the Pi knows the
   *  bot's ids, so this is computed there, never from the text. */
  quotedFromMatchTime?: boolean;
}

/**
 * Did this message tag @Match Time? FACTS ONLY (2026-10-30, "no string
 * parsing"; tightened by the review of PR #476):
 *
 *  - msg.botMentioned === true: the Pi matched the bot in the message's
 *    mention list (`whatsapp-bot/src/mentions.ts`, the same function that
 *    rewrites the mention into "@Match Time", so the two cannot disagree);
 *  - msg.quotedFromMatchTime === true: a WhatsApp reply quoting
 *    MatchTime's own message (Kemal, 2026-10-16: FNF's "Bench? We do
 *    bench now?"); a reply quoting a player is not.
 *
 * This is the gate for anything that CHANGES something (a write, a
 * reminder, the teams, payments). The router's own reading (`to_bot`)
 * never counts here, and an ANSWER is stricter still: see
 * `messageAddressesBot`. Until 2026-10-30 a text fallback matched "match
 * time", "matchtime" or "@mt" in the body; it is gone.
 */
export function messageTagsBot(msg: TagInput): boolean {
  return msg.botMentioned === true || msg.quotedFromMatchTime === true;
}

/**
 * May MatchTime ANSWER this group message? THE ONE GATE for every answer
 * in the players' group: a question (the count, the list, a fixture, the
 * club, stats, a person's place), help and how it works, and showing the
 * teams.
 *
 * Only the Pi's real @-mention flag opens it (Kemal, 2026-10-31, the rule
 * HQ got in #482: "real tag pls"). These do NOT, and each is silent, with
 * no "tag me" line:
 *  - the router's own `to_bot` reading ("MatchTime who runs this club?"
 *    with no mention: until 2026-10-31 it was enough to answer);
 *  - "MatchTime" typed as text;
 *  - a WhatsApp reply quoting MatchTime's own post, without the tag
 *    (`quotedFromMatchTime`: it still counts for `messageTagsBot`).
 *
 * Attendance never reads this: a player's own IN or OUT, a friend added,
 * an organiser reporting someone OUT and a replacement stay tag-free
 * (`actionRequiresTag`), and the action gate stays `messageTagsBot`.
 */
export function messageAddressesBot(msg: TagInput): boolean {
  return piMentionsBot(msg);
}

/**
 * Did the Pi report a real @-mention of the bot (2026-10-30)? The STRICT
 * fact the bulk-DM doors read ("message everyone their stats", a recruit
 * blast): never a reply, never the router, never the bot's name typed as
 * text. Replaces `messageMentionsBotExplicitly`, which also matched
 * "@Match Time" in the body.
 */
export function piMentionsBot(msg: Partial<TagInput>): boolean {
  return msg.botMentioned === true;
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
 * Is this verdict ATTENDANCE, the class that never needs a tag? True when
 *   - the intent is an attendance intent (in / out / conditional_in /
 *     replacement_request), OR
 *   - it adds, drops, benches or replaces anybody else (`registerFor`).
 *
 * We deliberately DON'T require registerAttendance to be populated: a bare
 * intent:"in" whose registerAttendance the server backfills later is still
 * attendance.
 */
export function isAttendanceVerdict(v: GateVerdict): boolean {
  const ATTENDANCE_INTENTS = new Set([
    "in",
    "out",
    "conditional_in",
    "replacement_request",
  ]);
  return ATTENDANCE_INTENTS.has(v.intent) || (v.registerFor?.length ?? 0) > 0;
}

/**
 * Does acting on this verdict REQUIRE an @Match Time tag?
 *
 * No for attendance, the sender's own or anybody else's
 * (`isAttendanceVerdict`).
 * No when there's nothing to do (noise/unclear with no writes): there's
 * no action to gate, and the noise path already keeps MT silent.
 * Yes for everything else action/answer-y: questions, team ops,
 * reminders, payment, score handling.
 */
export function actionRequiresTag(v: GateVerdict): boolean {
  if (isAttendanceVerdict(v)) return false;

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
