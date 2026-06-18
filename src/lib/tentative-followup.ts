/**
 * TENTATIVE AVAILABILITY FOLLOW-UP — pure, unit-testable core.
 *
 * When a player signals UNCERTAIN availability for a match ("maybe, I'll
 * confirm later", "in if my back holds up", "I'll check closer to the
 * match"), the analyzer classifies it as intent="conditional_in" with NO
 * attendance write (flavour b, personal-uncertainty). We record them as a
 * MAYBE for that match (TentativeAvailability), then the scheduler DMs
 * them ~24h before kickoff to get a firm IN/OUT, and folds the answer
 * back into the squad.
 *
 * Everything time/state-decision here is PURE code (no DB, no LLM, no
 * clock except an injected `now`) so it's deterministic and unit-testable
 * — the route + scheduler load rows and delegate the decisions here, the
 * same "code decides" pattern as registration-match-select.ts.
 */

/**
 * How far before kickoff the follow-up DM fires. SINGLE source of truth —
 * change this one constant to retune the lead time. 24h by default.
 */
export const TENTATIVE_FOLLOWUP_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * If kickoff is already inside the lead window when the player declares
 * tentative, we don't schedule the DM in the past — we fire it "soon"
 * instead. This is that "soon" offset from declaration time.
 */
export const TENTATIVE_FOLLOWUP_MIN_DELAY_MS = 5 * 60 * 1000;

/**
 * Compute the instant the follow-up DM should fire.
 *
 * Normally `kickoff − LEAD`. But if that instant is already in the past
 * (or within MIN_DELAY) relative to `now` — i.e. the player declared
 * tentative late, inside the 24h window — we clamp it to `now + MIN_DELAY`
 * so the DM still goes out shortly rather than never / in the past.
 *
 * @param kickoff  match kickoff instant
 * @param now      declaration instant (injectable for tests)
 */
export function computeFollowupDueAt(kickoff: Date, now: Date = new Date()): Date {
  const ideal = kickoff.getTime() - TENTATIVE_FOLLOWUP_LEAD_MS;
  const soonest = now.getTime() + TENTATIVE_FOLLOWUP_MIN_DELAY_MS;
  return new Date(Math.max(ideal, soonest));
}

/** A row is DUE when it's unresolved, not yet notified, and dueAt ≤ now. */
export function isFollowupDue(
  row: { dueAt: Date; notifiedAt: Date | null; resolvedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (row.resolvedAt) return false;
  if (row.notifiedAt) return false;
  return row.dueAt.getTime() <= now.getTime();
}

export type GuardMatchStatus =
  | "UPCOMING"
  | "TEAMS_GENERATED"
  | "TEAMS_PUBLISHED"
  | "COMPLETED"
  | "CANCELLED"
  | string;

export type GuardAttendanceStatus = "CONFIRMED" | "BENCH" | "DROPPED" | null;

/**
 * SEND-TIME GUARD. When a follow-up is about to fire, re-check the
 * player's CURRENT state — there's no point asking "in or out?" if they
 * already resolved it themselves, or the match is no longer takeable.
 *
 * Returns:
 *   - "send"  → DM them; they're still genuinely unresolved.
 *   - "skip"  → don't DM, but mark the tentative record resolved (the
 *               question is now moot — they confirmed/dropped, or the
 *               match completed/cancelled, or the squad is full).
 *
 * Best-effort / prefer-not-spamming: anything that makes the question
 * pointless resolves silently rather than risk a useless ping.
 */
export function evaluateFollowupGuard(args: {
  matchStatus: GuardMatchStatus;
  /** Current attendance status of the player for THIS match (null = none). */
  attendanceStatus: GuardAttendanceStatus;
  /** Confirmed count vs capacity — squad full means no slot to offer. */
  confirmedCount: number;
  maxPlayers: number;
}): "send" | "skip" {
  const { matchStatus, attendanceStatus, confirmedCount, maxPlayers } = args;

  // Match no longer takeable → moot.
  if (matchStatus === "COMPLETED" || matchStatus === "CANCELLED") return "skip";

  // Player already gave a firm answer since declaring tentative.
  if (attendanceStatus === "CONFIRMED" || attendanceStatus === "DROPPED") {
    return "skip";
  }
  // BENCH means they actively chose a standing-offer slot — also resolved
  // enough that chasing "in or out?" would be confusing.
  if (attendanceStatus === "BENCH") return "skip";

  // Squad already full → no point asking them to come in (the bench/offer
  // machinery, not this follow-up, handles a full squad). Prefer silence.
  if (confirmedCount >= maxPlayers) return "skip";

  return "send";
}
