/**
 * WHICH OF ITS MONTHS A MATCH IS, AS THE SCHEDULER TREATS IT (club summary,
 * slice A1, MDs/club-summary-design-2026-11-04.md 4.2). PURE.
 *
 * The month facts are the club summary's (`MatchFacts.month`). This maps
 * them onto the three shapes `computeDuePosts` has always used, with
 * exactly the rules it used to work them out from its own reads (Phase A:
 * no value changes; B2 makes one month phase for every consumer):
 *
 *   - "month": a game of a RUNNING month of its fixture, or of one closed in
 *     the last `CLOSED_MONTH_GATE_DAYS` when the game is not still to be
 *     played (`monthForMatch` over `loadSchedulerMonths`, then "a closed
 *     month is never the month of a game still to play"); never a game
 *     before a part-way start;
 *   - "signup": a month in sign-up whose list has opened, this London month
 *     or the next (`signupListPosts` over `loadLiveMonths`); a priced month,
 *     or an open one before its list opens, is not;
 *   - "held": a month MatchTime holds for its organiser (a held key), when
 *     neither of the above;
 *   - "none": anything else (`noMonthYet` for a monthly club).
 *
 * Two cases today's code left to the database's row order, and the
 * summary decides by its rank (running, closed, open, priced): two month
 * rows of one fixture and one London month (the month list keeps one per
 * fixture), and a month whose sign-up list has no game left on its
 * calendar (every week of it called off). Neither occurs in a club that
 * MatchTime runs.
 */
import { CLOSED_MONTH_GATE_DAYS } from "./scheduler-windows";
import { londonMonthStart } from "./squad-month-rules";
import { nextMonthStart } from "./month-signup-rules";
import type { MatchMonthFacts, MonthFacts } from "./club-summary/types";

export type SchedulerMonthShape =
  | { kind: "month"; monthId: string; seeded: boolean }
  | { kind: "signup"; monthId: string }
  | { kind: "held" }
  | { kind: "none" };

const LIVE = new Set(["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export function schedulerMonthShape(p: {
  /** The match's month facts; null for a weekly club. */
  facts: MatchMonthFacts | null;
  /** The club's months (`ClubSummary.squad.months`). */
  months: MonthFacts[];
  match: { status: string; date: Date };
  now: Date;
}): SchedulerMonthShape {
  const f = p.facts;
  if (!f) return { kind: "none" };
  const row = f.monthId ? (p.months.find((x) => x.id === f.monthId) ?? null) : null;
  const stillToPlay = LIVE.has(p.match.status) && p.match.date.getTime() > p.now.getTime();
  const closedLately =
    f.phase === "closed" && row?.closedAt != null && new Date(row.closedAt).getTime() >= p.now.getTime() - CLOSED_MONTH_GATE_DAYS * DAY_MS;
  if (f.monthId && !f.beforeStart && (f.phase === "running" || (closedLately && !stillToPlay))) {
    return { kind: "month", monthId: f.monthId, seeded: f.seeded };
  }
  const current = londonMonthStart(p.now);
  if (f.monthId && f.phase === "signup" && f.listOpened && (f.monthStart === current || f.monthStart === nextMonthStart(current))) {
    return { kind: "signup", monthId: f.monthId };
  }
  if (f.held) return { kind: "held" };
  return { kind: "none" };
}
