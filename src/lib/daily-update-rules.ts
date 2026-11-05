/**
 * THE DAILY 17:00 UPDATE: is it due, and which post is it? (Kemal, 2026-11-04)
 *
 * ONE rule for every club, weekly and monthly, read by both the players'
 * group path and the organisers' path in `bot-scheduler.ts` (block 2), so
 * the two can never disagree:
 *
 *   places open            the update goes out every day before the match;
 *   full, bench below 3    it keeps going: the squad, the bench, and an ask
 *                          for benchers (`BENCH_THIN_BELOW`);
 *   full, bench of 3+      it STOPS. Kemal: too much noise. A drop that opens
 *                          a place, or a bench that falls below 3, brings it
 *                          back on its own, because this is read afresh on
 *                          every poll from the rows as they are.
 *
 * The exceptions, unchanged:
 *   - a club with a weekly rhythm (drop-out deadline AND list time) posts
 *     only on match day;
 *   - match day with the teams made: the line-ups (players' group only);
 *     a month's list is never posted beside a team sheet on any day;
 *   - a weekly squad, full, with the teams made: nothing on any other day
 *     either, to the group or the organisers (2026-11-05); a place open
 *     still chases;
 *   - match day, a weekly squad full and no teams: the "make the teams"
 *     nudge. It is not the squad-and-bench reminder this rule stops, and it
 *     goes out once, on match day;
 *   - the "Squad complete" post went out today (`<matchId>:squad-locked`)
 *     and the bench is still thin: no second roster that day, only the
 *     unpaid tail (weekly group);
 *   - a monthly club's match with no list to show (no month yet, a month in
 *     sign-up or held, or the regulars not on the game yet): nothing;
 *   - after the attendance deadline: nothing.
 *
 * A STOP IS NOTHING. Full with 3 or more on the bench, the players' group
 * gets nothing that evening, not even the unpaid tail on its own (main
 * session review of #535, on Kemal's "too much noise": payment chasing
 * already happens by DM). It wins over the "Squad complete" exception. A
 * monthly club's post never has an unpaid tail anyway: its regulars pay for
 * the month, not the game.
 *
 * Pure: facts in, a decision out. The caller reads the rows; nothing here
 * touches the database, a model or the clock.
 */
import { BENCH_THIN_BELOW } from "./scheduler-copy";

/**
 * Whose squad the post shows.
 *   weekly    a weekly club (every club before monthly mode);
 *   month     a running month whose regulars are on this match: the post is
 *             the month's list, in the group's own format;
 *   no-month  a monthly club's match with no list to show yet.
 */
export type DailySquad = "weekly" | "month" | "no-month";

export interface DailyUpdateFacts {
  /** The players' group, or the organisers (`organisersAnnounce`, FNF). */
  audience: "group" | "organisers";
  squad: DailySquad;
  /** Today (London) is the match's day. */
  isMatchDay: boolean;
  /** Teams have been made for this match. */
  teamsOut: boolean;
  /** A club with both weekly deadlines, on a day that is not match day. */
  weeklyRhythmDay: boolean;
  /** Before the match's attendance deadline. */
  beforeDeadline: boolean;
  /** Places still free (max players less the confirmed). */
  open: number;
  /** Players on the bench. */
  bench: number;
  /** The "Squad complete" post was claimed today (London). */
  squadLockedToday: boolean;
}

/** Why nothing goes out. */
export type DailySkip =
  | "weekly-rhythm-day"
  | "teams-out"
  | "no-month-list"
  | "month-list-in-group"
  | "after-deadline"
  | "bench-covered"
  | "squad-locked-today";

export type DailyUpdate =
  /** Match day, teams made: the two line-ups. */
  | { post: "line-ups" }
  /** Match day, a weekly squad full, no teams yet: the roster and the nudge. */
  | { post: "match-day-locked" }
  /** Places open: the squad so far and the call for players. */
  | { post: "chase" }
  /** Full, bench below `BENCH_THIN_BELOW`: squad, bench, the bench ask. */
  | { post: "squad-full" }
  /** The month's list. `benchAsk`: the squad is full and the bench is thin. */
  | { post: "month-list"; benchAsk: boolean }
  /** "Squad complete" went out today and the bench is thin: no second
   *  roster; the unpaid tail goes out alone if there is one. */
  | { post: "unpaid-only"; why: "squad-locked-today" }
  | { post: null; why: DailySkip };

/** Enough cover behind a full squad: the daily post stops. */
export function benchCovered(bench: number): boolean {
  return bench >= BENCH_THIN_BELOW;
}

export function decideDailyUpdate(f: DailyUpdateFacts): DailyUpdate {
  const organisers = f.audience === "organisers";
  if (f.weeklyRhythmDay) return { post: null, why: "weekly-rhythm-day" };
  if (f.isMatchDay && f.teamsOut) return organisers ? { post: null, why: "teams-out" } : { post: "line-ups" };
  if (f.squad === "no-month") return { post: null, why: "no-month-list" };
  // The month's list is posted in the players' group (block 2-monthly),
  // never to the organisers.
  if (f.squad === "month" && organisers) return { post: null, why: "month-list-in-group" };
  // The month's list is never posted once the teams are out, whatever the
  // day: the team sheet is the announcement then (`decideListPost`).
  if (f.squad === "month" && f.teamsOut) return { post: null, why: "teams-out" };
  // A weekly squad, full, with the teams out: nothing on any day, to anyone
  // (Kemal, 2026-11-05: the teams and the poster are out, the squad again
  // "just creates noise"). Match day's line-ups above still win; a place
  // open still chases below.
  if (f.squad === "weekly" && f.teamsOut && f.open === 0) return { post: null, why: "teams-out" };
  if (f.squad === "weekly" && f.isMatchDay && f.open === 0) return { post: "match-day-locked" };
  if (!f.beforeDeadline) return { post: null, why: "after-deadline" };

  if (f.open > 0) return f.squad === "month" ? { post: "month-list", benchAsk: false } : { post: "chase" };

  // The squad is full. A covered bench is a STOP for everyone: nothing at
  // all, not even the unpaid tail on its own (payment chasing is by DM).
  if (benchCovered(f.bench)) return { post: null, why: "bench-covered" };
  // No "Squad complete" post is ever sent for a month (squad-announce.ts),
  // so its claim (which the monthly seed can write) silences nothing.
  if (f.squad === "month") return { post: "month-list", benchAsk: true };
  if (f.squadLockedToday) {
    return organisers ? { post: null, why: "squad-locked-today" } : { post: "unpaid-only", why: "squad-locked-today" };
  }
  return { post: "squad-full" };
}
