/**
 * WHAT A MONTHLY CLUB'S GAME GETS, FROM ITS MONTH PHASE (club summary,
 * slice B2, MDs/club-summary-design-2026-11-04.md section 3.18). PURE: no
 * database, no clock but the one passed in, no model.
 *
 * The phase is the summary's fact (`MatchMonthFacts.phase`, one function:
 * `monthPhaseFor`). This file is the one place that turns it into what the
 * consumers do, so the scheduler, the deadline summary, the unpaid list,
 * "Squad complete" and the players' group IN hold can no longer disagree
 * (D2, D5).
 *
 *   "weekly"         a weekly club: every weekly post, as before.
 *   "month-pending"  a monthly club's game whose month is not under way: no
 *                    month yet, held for its organiser, in sign-up, or a
 *                    closed month's game still to play. Nothing that counts
 *                    the squad, asks for more or asks for money goes out (a
 *                    weekly post never reaches a monthly club): no 17:00
 *                    post, chase, deadline post, "Squad complete", payment
 *                    poll, unpaid reminder or list, fee ask or recruit
 *                    chase, on the players' group or the organisers' side.
 *   "month"          a game of a running month, or a played game of a
 *                    closed one: the month's own flow (its list, its
 *                    regulars, pay as you go for the open places).
 *
 * A monthly club's match the caller has no month fact for is pending, never
 * weekly: the weekly flow is what must not reach it.
 */
import type { MatchMonthFacts } from "./club-summary/types";
import type { SquadMode } from "./squad-month-rules";

export type MonthFlow = "weekly" | "month-pending" | "month";

const LIVE = new Set(["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]);

/** A live match that has not kicked off yet. */
export function stillToPlay(m: { status: string; date: Date }, now: Date): boolean {
  return LIVE.has(m.status) && m.date.getTime() > now.getTime();
}

export function monthFlowOf(p: { mode: SquadMode; month: Pick<MatchMonthFacts, "phase"> | null; stillToPlay: boolean }): MonthFlow {
  if (p.mode !== "monthly") return "weekly";
  const phase = p.month?.phase ?? "none";
  if (phase === "running") return "month";
  // A month is closed the morning after its last game, while that game's
  // after-match posts are still due: they go on treating it as the month's.
  if (phase === "closed" && !p.stillToPlay) return "month";
  return "month-pending";
}

/**
 * THE PLAYERS' GROUP IN HOLD (#502, Kemal 2026-11-03): for a monthly club
 * the squad starts from the posted monthly list, so nobody joins by saying
 * IN before the month exists. True for a game with no month yet or one held
 * for its organiser. A month in sign-up, running or closed is the monthly
 * flow's own business. An unknown month (no fact) is not "not started".
 */
export function monthNotStartedOf(p: { mode: SquadMode; month: Pick<MatchMonthFacts, "phase"> | null }): boolean {
  if (p.mode !== "monthly" || !p.month) return false;
  return p.month.phase === "none" || p.month.phase === "held";
}
