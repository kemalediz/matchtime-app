/**
 * Deterministic selection of the ACTIVE registration match — the single
 * match that an attendance write (IN / OUT / BENCH / registerFor) lands
 * on, and the same match the LLM context + reply post-processors should
 * describe.
 *
 * GUIDING PRINCIPLE: "code decides". Timing/state is pure code, never LLM
 * judgment, and never influenced by fullness.
 *
 * The active match is the SOONEST upcoming match in the CURRENT cycle:
 *   - REGARDLESS of how full it is (a full squad routes new INs to the
 *     bench WITHIN that match — it must never advance the target to a
 *     later, emptier match). This is the 2026-06-18 Sutton Lads bug.
 *   - REGARDLESS of attendanceDeadline (registration is open right up to
 *     kickoff/completion; the deadline is not a registration gate).
 *   - We do NOT roll forward to next week's auto-created match while a
 *     non-completed match dated before today is still in flight (the
 *     cron hasn't completed last cycle yet).
 *
 * Pure function so it's unit-testable and so every read/write path can
 * share one source of truth for "which match".
 */

export type RegistrationMatchStatus =
  | "UPCOMING"
  | "TEAMS_GENERATED"
  | "TEAMS_PUBLISHED"
  | "COMPLETED"
  | "CANCELLED"
  | string;

export interface SelectableMatch {
  id: string;
  date: Date;
  status: RegistrationMatchStatus;
  /** Present on real rows but intentionally IGNORED by the selector. */
  attendanceDeadline?: Date;
}

const ACTIVE_STATUSES = new Set([
  "UPCOMING",
  "TEAMS_GENERATED",
  "TEAMS_PUBLISHED",
]);

/** UTC midnight of the day `now` falls on. */
function utcDayStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Decide the active registration match from a set of candidate matches.
 *
 * @param matches  Candidate matches for the org. May include COMPLETED /
 *                 past / future rows; the selector filters them.
 * @param now      Reference instant (injectable for tests).
 * @returns        The active match, or null when registration must be
 *                 BLOCKED (a previous match is still in flight) or there
 *                 is no upcoming match.
 */
export function selectRegistrationMatch<T extends SelectableMatch>(
  matches: T[],
  now: Date = new Date(),
): T | null {
  const todayStart = utcDayStart(now);

  // Block while ANY non-completed match dated before today is still in
  // flight — the weekly cron hasn't completed the previous cycle yet, so
  // we must not roll attendance forward onto a future match.
  const inFlight = matches.some(
    (m) => ACTIVE_STATUSES.has(m.status) && m.date < todayStart,
  );
  if (inFlight) return null;

  // Soonest active match dated today-or-later. Fullness and deadline are
  // deliberately NOT consulted.
  const candidates = matches
    .filter((m) => ACTIVE_STATUSES.has(m.status) && m.date >= todayStart)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return candidates[0] ?? null;
}
