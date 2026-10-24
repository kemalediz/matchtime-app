/**
 * NO-SHOWS, THE RESULT OF A GUEST'S GAME, AND THE PAUSES MATCHTIME DECIDES
 * (slice L7, 2026-10-24). PURE. Plan: MDs/local-player-pool-plan-2026-10-23.md
 * sections 5.5 and 9; decisions L7.x in MDs/local-player-pool-decisions-log.md.
 *
 *   noShowMarkWindow / noShowMarkRefusal
 *       An organiser marks a guest who held a place and did not come, from
 *       kickoff until `markWindowHours` after it, and can put him back to
 *       "played" in that time. Then the result is final.
 *   finalGuestResult
 *       What his `GuestPlace` says once the window closed: a confirmed
 *       guest nobody marked PLAYED; a result already recorded (no-show,
 *       late cancel, pulled out) stays; a place given up with nothing
 *       recorded was given up in time; a bench place never called up and a
 *       cancelled game are not games (settled, still "booked"; a cancelled
 *       game waits for its window too, as it may be put back on).
 *   countableGuestGames / standingPause
 *       Only final, not-cancelled games count; the pause that still applies
 *       to a profile made anew.
 *   pausesForNoShows
 *       `noShowPause.noShows` no-shows among his last `lastGames` counted
 *       guest games (every club, partner and pool guest games alike: one
 *       turn-up record, `turn-up.ts`) pause pool offers.
 *   selfResumeFrom
 *       When he may lift a pause himself on the manage page: his own and
 *       the ignored-offers pause at once; the no-show pause after
 *       `noShowResumeAfterDays`; reports and the owner never (he can ask a
 *       person to look at it).
 *   pausesForReports
 *       Open reports from `reportPauseClubs` different clubs pause him
 *       pending a person's review (plan 9).
 *   clubsMarkingTooMany
 *       A club that marked more than `clubFlag.players` different players
 *       no-show in `clubFlag.days` is shown to the owner (plan 5.5: a club
 *       abusing the marker).
 *   reportTextOf, safetyRecordPurgeBefore
 *       A report's text; block and report records kept 24 months after the
 *       profile is deleted (decision L0.3).
 */
import { POOL_MATCHTIME_PAUSE_REASONS, type GuestResult, type PoolPauseReason } from "./vocab";

export const POOL_RELIABILITY = {
  markWindowHours: 24,
  noShowPause: { noShows: 2, lastGames: 5 },
  noShowResumeAfterDays: 30,
  reportPauseClubs: 2,
  clubFlag: { players: 3, days: 30 },
  reportTextMin: 3,
  reportTextMax: 1000,
  safetyRecordMonthsAfterDeletion: 24,
} as const;

const H = 3600_000;
const DAY = 24 * H;

type Attendance = "CONFIRMED" | "BENCH" | "DROPPED" | null;
type MatchStatus = "UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED" | "CANCELLED";

export function noShowMarkWindow(kickoff: Date): { opensAt: Date; closesAt: Date } {
  return { opensAt: kickoff, closesAt: new Date(kickoff.getTime() + POOL_RELIABILITY.markWindowHours * H) };
}

export type NoShowMarkRefusal = "not-started" | "closed" | "not-playing" | "cancelled";

/** May an organiser set (`noShow`) or clear this guest's no-show now? */
export function noShowMarkRefusal(a: {
  result: GuestResult;
  settled: boolean;
  attendance: Attendance;
  matchStatus: MatchStatus;
  kickoff: Date;
  noShow: boolean;
  now: Date;
}): NoShowMarkRefusal | null {
  if (a.matchStatus === "CANCELLED") return "cancelled";
  const w = noShowMarkWindow(a.kickoff);
  if (a.now.getTime() < w.opensAt.getTime()) return "not-started";
  if (a.settled || a.now.getTime() >= w.closesAt.getTime()) return "closed";
  // A bench place never held a place. No row (or a dropped one) on a place
  // still booked is a guest taken off AFTER kickoff (review of #404, 6):
  // every drop before kickoff records its own result.
  if (a.attendance === "BENCH") return "not-playing";
  if (a.result !== "booked" && a.result !== "no-show") return "not-playing";
  return null;
}

/** His game's final result, or null while the window is still open. */
export function finalGuestResult(a: { result: GuestResult; attendance: Attendance; matchStatus: MatchStatus; kickoff: Date; now: Date }): { result: GuestResult } | null {
  // A cancelled match waits like any other (review of #404, 2: it may be
  // put back on), then is not a game: any recorded result is cleared (8).
  if (a.now.getTime() < noShowMarkWindow(a.kickoff).closesAt.getTime()) return null;
  if (a.matchStatus === "CANCELLED") return { result: "booked" };
  if (a.result !== "booked") return { result: a.result };
  if (a.attendance === "CONFIRMED") return { result: "played" };
  if (a.attendance === "BENCH") return { result: "booked" };
  return { result: "withdrawn" };
}

const COUNTED: ReadonlySet<GuestResult> = new Set(["played", "no-show", "late-cancel"]);

export function pausesForNoShows(games: readonly { kickoff: Date; result: GuestResult }[]): boolean {
  const { noShows, lastGames } = POOL_RELIABILITY.noShowPause;
  const last = games
    .filter((g) => COUNTED.has(g.result))
    .sort((a, b) => b.kickoff.getTime() - a.kickoff.getTime())
    .slice(0, lastGames);
  return last.filter((g) => g.result === "no-show").length >= noShows;
}

/**
 * The games his record and his pause count (review of #404, 1 and 8): only
 * FINAL results (the window closed, so no organiser can still undo them),
 * never a game whose match was cancelled.
 */
export function countableGuestGames<T extends { settledAt: Date | null; cancelled: boolean }>(games: readonly T[]): T[] {
  return games.filter((g) => g.settledAt !== null && !g.cancelled);
}

/**
 * The pause MatchTime decided that still applies to him, from his records,
 * for a profile made anew (review of #404, 4: deleting the profile and
 * signing up again must not lift it). Open club reports from two clubs: a
 * report pause now. Otherwise the no-show rule on his final games, dated
 * from the latest final no-show, unless its 30 days are already over.
 */
export function standingPause(a: {
  games: readonly { kickoff: Date; result: GuestResult; settledAt: Date | null; cancelled: boolean }[];
  openClubReportOrgs: readonly string[];
  now: Date;
}): { reason: "no-shows" | "reports"; pausedAt: Date } | null {
  if (pausesForReports(a.openClubReportOrgs.map((orgId) => ({ orgId, by: "club" as const, reviewed: false })))) return { reason: "reports", pausedAt: a.now };
  const games = countableGuestGames(a.games);
  if (!pausesForNoShows(games)) return null;
  const last = Math.max(...games.filter((g) => g.result === "no-show").map((g) => g.settledAt!.getTime()));
  const pausedAt = new Date(last);
  const until = selfResumeFrom({ reason: "no-shows", pausedAt })!;
  return until.getTime() > a.now.getTime() ? { reason: "no-shows", pausedAt } : null;
}

/** From when he may lift this pause himself, or null for never (a
 *  no-show pause with no start time included). */
export function selfResumeFrom(a: { reason: PoolPauseReason; pausedAt: Date | null }): Date | null {
  switch (a.reason) {
    case "self":
    case "ignored":
      return a.pausedAt ?? new Date(0);
    case "no-shows":
      return a.pausedAt ? new Date(a.pausedAt.getTime() + POOL_RELIABILITY.noShowResumeAfterDays * DAY) : null;
    default:
      return null;
  }
}

/** The pauses only MatchTime (or a person reviewing it) decides. A stop
 *  keeps them, so stopping and starting again cannot lift them. */
export const MATCHTIME_PAUSE_REASONS: readonly PoolPauseReason[] = POOL_MATCHTIME_PAUSE_REASONS;

export function pausesForReports(reports: readonly { orgId: string; by: "club" | "player"; reviewed: boolean }[]): boolean {
  const clubs = new Set(reports.filter((r) => r.by === "club" && !r.reviewed).map((r) => r.orgId));
  return clubs.size >= POOL_RELIABILITY.reportPauseClubs;
}

export function clubsMarkingTooMany(marks: readonly { orgId: string; userId: string; at: Date }[], now: Date): { orgId: string; players: number }[] {
  const since = now.getTime() - POOL_RELIABILITY.clubFlag.days * DAY;
  const byClub = new Map<string, Set<string>>();
  for (const m of marks) {
    if (m.at.getTime() < since) continue;
    const set = byClub.get(m.orgId) ?? new Set<string>();
    set.add(m.userId);
    byClub.set(m.orgId, set);
  }
  return [...byClub]
    .filter(([, users]) => users.size > POOL_RELIABILITY.clubFlag.players)
    .map(([orgId, users]) => ({ orgId, players: users.size }))
    .sort((a, b) => b.players - a.players || a.orgId.localeCompare(b.orgId));
}

/** A report's text: trimmed, runs of spaces and blank lines tidied, capped. */
export function reportTextOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Characters (code points), as the database's length() counts them.
  const chars = [...text];
  if (chars.length < POOL_RELIABILITY.reportTextMin) return null;
  return chars.slice(0, POOL_RELIABILITY.reportTextMax).join("").trim();
}

/** Block and report records about someone whose profile was deleted
 *  before this are removed (decision L0.3). */
export function safetyRecordPurgeBefore(now: Date): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - POOL_RELIABILITY.safetyRecordMonthsAfterDeletion);
  return d;
}
