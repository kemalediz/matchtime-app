/**
 * RECRUIT CHASE-UP — one follow-up DM to the players who never answered
 * the recruit invite. Pure, unit-testable core (2026-08-31).
 *
 * WHY
 * ---
 * `inviteRecentPlayers` (src/lib/recruit.ts) DMs recent players when the
 * squad is short. A good half of them simply never reply: no IN, no OUT,
 * no 👍, nothing. The squad stays short and the admin ends up chasing by
 * hand. The owner asked for exactly ONE nudge to those players, and was
 * emphatic about the shape of it:
 *
 *   - ONE chase. Two messages per player per match, EVER. No second
 *     chase, no match-morning chase.
 *   - ANY response at all stops it. IN, OUT, 👍, 👎, "maybe", a question.
 *     Only true silence is chased.
 *   - Roughly 3h after that player's OWN invite went out.
 *
 * The club has just had a bad fortnight of bot misbehaviour (30+ duplicate
 * group posts, DMs that claimed things the database never recorded). So
 * every judgement call in here is biased HARD toward staying silent: a
 * player who is chased after already saying no is exactly the failure the
 * owner asked us to avoid, and one un-chased player merely costs us the
 * recruit we would not have had anyway.
 *
 * WHAT LIVES HERE vs IN THE SCHEDULER
 * -----------------------------------
 * Everything time- and state-decision is PURE here (no DB, no LLM, no
 * clock except an injected `now`), the same "code decides" split used by
 * tentative-followup.ts, dispatch-claim.ts and next-upcoming-match.ts.
 * `computeForMatch` in bot-scheduler.ts loads the rows, derives the
 * booleans, and delegates the decision to `shouldChaseRecruit`.
 *
 * IDEMPOTENCY
 * -----------
 * The chase is keyed `<matchId>:recruit-chase:<userId>` and rides the
 * existing SentNotification dedupe. Under claim-on-dispatch (see
 * MDs/SESSION-HANDOFF-2026-08-27.md section 1) that row is written at
 * hand-off, not at ACK, so a claimed chase can never be re-emitted even
 * if the bot dies before sending. That is deliberately AT-MOST-ONCE: a
 * missed chase beats a duplicate one.
 */

/**
 * How long after a player's OWN invite DM the single chase fires.
 * SINGLE source of truth — retune the delay by changing this constant.
 * Owner's call: roughly 3 hours (2026-08-31).
 */
export const RECRUIT_CHASE_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * Sociable-hours window, London wall clock, `[START, END)`.
 *
 * Reuses the ESTABLISHED convention rather than inventing one: the
 * bench-slot-offer DM in bot-scheduler.ts already gates personal,
 * actionable nudges on "London 08:00–21:59" ("never ping anyone about a
 * slot overnight"). A chase is the same class of message, so it gets the
 * same window. Missing the window is harmless: the chase is not lost, it
 * just waits for the next poll inside it (and if the match has gone by
 * then, `isMatchChaseable` correctly drops it).
 */
export const RECRUIT_CHASE_HOUR_START = 8;
export const RECRUIT_CHASE_HOUR_END = 22;

/** Hour-of-day 0-23 in Europe/London, DST-safe. Mirrors the private
 *  helper in bot-scheduler.ts; duplicated (not exported from there) so
 *  this module stays free of the scheduler's DB imports. */
export function londonHourOf(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: false,
  }).formatToParts(at);
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(h, 10);
}

/** Is `at` inside the sociable window for a chase DM? */
export function isSociableChaseHour(at: Date): boolean {
  const h = londonHourOf(at);
  return h >= RECRUIT_CHASE_HOUR_START && h < RECRUIT_CHASE_HOUR_END;
}

/** Match statuses the scheduler ever hands us. */
export type ChaseMatchStatus =
  | "UPCOMING"
  | "TEAMS_GENERATED"
  | "TEAMS_PUBLISHED"
  | "COMPLETED"
  | "CANCELLED"
  | string;

/**
 * Is this match still one we could honestly ask someone to join?
 *
 * Never chase about a match that has kicked off, completed or been
 * cancelled, and never past the attendance deadline — after that the
 * line-up is being built and a new IN is a disruption, not a help. Teams
 * being generated or published is NOT a bar on its own: those matches are
 * still ahead of their deadline in the normal case, and the deadline
 * check below is what actually closes the door.
 */
export function isMatchChaseable(args: {
  status: ChaseMatchStatus;
  attendanceDeadline: Date;
  now: Date;
}): boolean {
  const { status, attendanceDeadline, now } = args;
  if (status === "COMPLETED" || status === "CANCELLED") return false;
  if (
    status !== "UPCOMING" &&
    status !== "TEAMS_GENERATED" &&
    status !== "TEAMS_PUBLISHED"
  ) {
    // Unknown status — refuse. Silence is the safe default.
    return false;
  }
  return now.getTime() < attendanceDeadline.getTime();
}

export interface ShouldChaseRecruitInput {
  /** When THIS player's invite DM was dispatched (the
   *  `<matchId>:recruit-dm:<userId>` SentNotification's createdAt), or
   *  null if we have no record of inviting them. */
  invitedAt: Date | null;
  /** Injected clock. */
  now: Date;
  /** Did they answer in ANY way, by ANY route? See
   *  `hasRespondedToRecruit` in bot-scheduler.ts for the signal set. */
  hasResponded: boolean;
  /** Is the squad STILL short (open slots > 0)? */
  squadShort: boolean;
  /** Is the match still joinable — upcoming, not cancelled, deadline not
   *  passed? Derive with {@link isMatchChaseable}. */
  matchLive: boolean;
  /** Membership.subMatchInviteDm — false means they asked us not to send
   *  match invites, a promise already kept by the initial blast. */
  subscribed: boolean;
  /** Has the one chase already been dispatched for this match+user? */
  alreadyChased: boolean;
}

/**
 * THE decision. Ordered so the loudest "no" is checked first, which makes
 * the guard list read as the owner's rules in the owner's order.
 */
export function shouldChaseRecruit(input: ShouldChaseRecruitInput): boolean {
  const {
    invitedAt,
    now,
    hasResponded,
    squadShort,
    matchLive,
    subscribed,
    alreadyChased,
  } = input;

  // ONE chase, ever. This is belt-and-braces on top of the
  // SentNotification key: the key is the real arbiter, but the rule is
  // important enough to state in code that a reader can see.
  if (alreadyChased) return false;

  // A promise already made to this player when we skipped them in the
  // initial blast. Never a tuning option.
  if (!subscribed) return false;

  // Any answer at all, however given, ends it.
  if (hasResponded) return false;

  // Nothing to chase about.
  if (!matchLive) return false;
  if (!squadShort) return false;

  // No invite on record → nothing to follow up. Chasing someone we never
  // asked would be the bot inventing a conversation.
  if (!invitedAt) return false;

  if (now.getTime() - invitedAt.getTime() < RECRUIT_CHASE_AFTER_MS) return false;

  // Not in the middle of the night.
  return isSociableChaseHour(now);
}

/** The idempotency key for the one chase. Never collides with the
 *  invite's own `<matchId>:recruit-dm:<userId>`. */
export function recruitChaseKey(matchId: string, userId: string): string {
  return `${matchId}:recruit-chase:${userId}`;
}

/**
 * AnalyzedMessage.intent values that mean "this player answered about
 * playing". Used as signal 3 in the scheduler's response detection.
 *
 * Deliberately the attendance-ish set rather than "any message they
 * posted": a laugh reaction to someone else's joke is not an answer, and
 * we already have three other signals covering the routes that do write
 * something. `replacement_request` is included because "I cannot play,
 * someone take my spot" is unambiguously a no.
 */
export const ATTENDANCE_ISH_INTENTS: readonly string[] = [
  "in",
  "out",
  "conditional_in",
  "conditional_out",
  "replacement_request",
];

/**
 * The chase copy. Short, warm, no pressure, and answerable with one word.
 *
 * Telling them how to make it stop ("reply OUT and I'll stop asking") is
 * deliberate: it is kinder than silence-by-default, and it converts a
 * non-answer into a real one we can act on. House style — no em dashes,
 * no slashes.
 */
export function buildRecruitChaseText(args: {
  playerName: string | null;
  activityName: string;
  /** Pre-formatted London wall clock, e.g. "Tue 2 Sep, 20:00". */
  matchWhen: string;
  /** Open slots on the squad right now. */
  need: number;
}): string {
  const { playerName, activityName, matchWhen, need } = args;
  const first = playerName?.trim().split(/\s+/)[0] || "there";
  const count = Math.max(1, Math.floor(need));
  const players = count === 1 ? "player" : "players";
  return (
    `👋 ${first}, still after ${count} ${players} for *${activityName}* on ${matchWhen}. ` +
    `Reply *IN* if you fancy it, or *OUT* and I'll stop asking 🙏`
  );
}
