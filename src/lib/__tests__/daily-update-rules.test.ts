/**
 * THE ONE RULE FOR THE DAILY 17:00 UPDATE (Kemal, 2026-11-04), as a table.
 *
 * Every club, weekly and monthly, players' group and organisers:
 *   - places open: the update goes out every day before the match;
 *   - squad full, bench below `BENCH_THIN_BELOW` (3): it keeps going,
 *     listing the squad and the bench and asking for benchers;
 *   - squad full, bench of 3 or more: it STOPS (too much noise), and
 *     starts again by itself when a drop opens a place or the bench falls
 *     below 3, because the rule is read afresh on every poll.
 * The exceptions that stay as they were: the "Squad complete" post sent
 * today, the weekly-rhythm days, match day with the teams made, a month
 * not started yet, and the organisers' copy (which follows the same stop).
 */
import { describe, it, expect } from "vitest";
import { decideDailyUpdate, decideDropOutReminder, type DailyUpdateFacts } from "@/lib/daily-update-rules";
import { BENCH_THIN_BELOW } from "@/lib/scheduler-copy";

/** A weekday before the match, before the deadline, players' group, weekly. */
const BASE: DailyUpdateFacts = {
  audience: "group",
  squad: "weekly",
  isMatchDay: false,
  teamsOut: false,
  weeklyRhythmDay: false,
  beforeDeadline: true,
  open: 0,
  bench: 0,
  squadLockedToday: false,
};
const decide = (over: Partial<DailyUpdateFacts>) => decideDailyUpdate({ ...BASE, ...over });

describe("the floor is the bench rule's own constant", () => {
  it("BENCH_THIN_BELOW is 3", () => {
    expect(BENCH_THIN_BELOW).toBe(3);
  });
});

describe("WEEKLY, players' group", () => {
  it.each([
    ["places open", { open: 2, bench: 0 }, { post: "chase" }],
    ["places open with a bench (a drop after stopping)", { open: 1, bench: 4 }, { post: "chase" }],
    ["full, bench 0", { bench: 0 }, { post: "squad-full" }],
    ["full, bench 1", { bench: 1 }, { post: "squad-full" }],
    ["full, bench 2", { bench: 2 }, { post: "squad-full" }],
    // The 2026-11-04 decision: three or more on the bench, the post STOPS.
    // NOTHING goes to the players' group that evening, not even the unpaid
    // tail on its own (main session review of #535: payment chasing
    // already happens by DM).
    ["full, bench 3", { bench: 3 }, { post: null, why: "bench-covered" }],
    ["full, bench 4", { bench: 4 }, { post: null, why: "bench-covered" }],
    ["full, the bench falls back to 2", { bench: 2 }, { post: "squad-full" }],
  ] as const)("%s", (_label, over, want) => {
    expect(decide(over)).toEqual(want);
  });

  it("the 'Squad complete' post sent today: only the unpaid tail while the bench is thin; a covered bench is still a stop", () => {
    expect(decide({ squadLockedToday: true, bench: 0 })).toEqual({ post: "unpaid-only", why: "squad-locked-today" });
    expect(decide({ squadLockedToday: true, bench: 2 })).toEqual({ post: "unpaid-only", why: "squad-locked-today" });
    expect(decide({ squadLockedToday: true, bench: 5 })).toEqual({ post: null, why: "bench-covered" });
    // A place open again: the claim was cleared by the drop, but even a
    // stale one never silences the chase.
    expect(decide({ squadLockedToday: true, open: 1 })).toEqual({ post: "chase" });
  });

  it("a weekly-rhythm club posts nothing on a day that is not match day", () => {
    expect(decide({ weeklyRhythmDay: true, open: 3 })).toEqual({ post: null, why: "weekly-rhythm-day" });
    expect(decide({ weeklyRhythmDay: true, bench: 0 })).toEqual({ post: null, why: "weekly-rhythm-day" });
  });

  it("match day with the teams made: the line-ups, whatever the numbers", () => {
    expect(decide({ isMatchDay: true, teamsOut: true, bench: 5 })).toEqual({ post: "line-ups" });
    expect(decide({ isMatchDay: true, teamsOut: true, open: 2, beforeDeadline: false })).toEqual({ post: "line-ups" });
  });

  it("match day, full, no teams yet: the 'make the teams' nudge stays, bench or no bench", () => {
    expect(decide({ isMatchDay: true, bench: 0 })).toEqual({ post: "match-day-locked" });
    expect(decide({ isMatchDay: true, bench: 4, beforeDeadline: false })).toEqual({ post: "match-day-locked" });
  });

  it("after the deadline nothing goes out (a later tick can still send once things change)", () => {
    expect(decide({ beforeDeadline: false, open: 2 })).toEqual({ post: null, why: "after-deadline" });
    expect(decide({ beforeDeadline: false, bench: 0 })).toEqual({ post: null, why: "after-deadline" });
  });
});

describe("MONTHLY, players' group: the month's list", () => {
  const month = (over: Partial<DailyUpdateFacts>) => decide({ squad: "month", ...over });

  it.each([
    ["places open: the list with its open places", { open: 1, bench: 0 }, { post: "month-list", benchAsk: false }],
    ["full, bench 0: the list and the bench ask", { bench: 0 }, { post: "month-list", benchAsk: true }],
    ["full, bench 1", { bench: 1 }, { post: "month-list", benchAsk: true }],
    ["full, bench 2", { bench: 2 }, { post: "month-list", benchAsk: true }],
    ["full, bench 3: stops", { bench: 3 }, { post: null, why: "bench-covered" }],
    ["full, bench 4: stops", { bench: 4 }, { post: null, why: "bench-covered" }],
    ["a drop after stopping: back, with the open place", { open: 1, bench: 4 }, { post: "month-list", benchAsk: false }],
  ] as const)("%s", (_label, over, want) => {
    expect(month(over)).toEqual(want);
  });

  it("never an unpaid tail: a regular pays for the month, not the game", () => {
    for (const bench of [0, 1, 2, 3, 4]) {
      expect(month({ bench }).post).not.toBe("unpaid-only");
    }
  });

  it("no 'Squad complete' post is sent for a month, so its claim does not silence the list", () => {
    // The monthly seed can write `<matchId>:squad-locked` without posting.
    expect(month({ squadLockedToday: true, bench: 0 })).toEqual({ post: "month-list", benchAsk: true });
  });

  it("match day with the teams made: the line-ups", () => {
    expect(month({ isMatchDay: true, teamsOut: true })).toEqual({ post: "line-ups" });
  });

  it("teams made before match day: no list beside the team sheet (the list's own rule)", () => {
    expect(month({ teamsOut: true, open: 1 })).toEqual({ post: null, why: "teams-out" });
    expect(month({ teamsOut: true, bench: 0 })).toEqual({ post: null, why: "teams-out" });
  });

  it("match day, full, no teams: the list rule, never the weekly-shaped nudge", () => {
    expect(month({ isMatchDay: true, bench: 1 })).toEqual({ post: "month-list", benchAsk: true });
    expect(month({ isMatchDay: true, bench: 3 })).toEqual({ post: null, why: "bench-covered" });
  });

  it("after the deadline nothing goes out", () => {
    expect(month({ beforeDeadline: false, open: 1 })).toEqual({ post: null, why: "after-deadline" });
  });

  it("a month not started yet (or in sign-up, or regulars not on the game): nothing, as today", () => {
    for (const over of [{ open: 13 }, { open: 0, bench: 0 }, { open: 0, bench: 5 }]) {
      expect(decide({ squad: "no-month", ...over })).toEqual({ post: null, why: "no-month-list" });
    }
    // The line-ups still go out on match day.
    expect(decide({ squad: "no-month", isMatchDay: true, teamsOut: true })).toEqual({ post: "line-ups" });
  });
});

describe("ORGANISERS (FNF-style): the admin copy follows the same stop", () => {
  const org = (over: Partial<DailyUpdateFacts>) => decide({ audience: "organisers", ...over });

  it.each([
    ["places open", { open: 2 }, { post: "chase" }],
    ["full, bench 0", { bench: 0 }, { post: "squad-full" }],
    ["full, bench 2", { bench: 2 }, { post: "squad-full" }],
    ["full, bench 3: stops", { bench: 3 }, { post: null, why: "bench-covered" }],
    ["full, bench 4: stops", { bench: 4 }, { post: null, why: "bench-covered" }],
    ["a drop after stopping", { open: 1, bench: 4 }, { post: "chase" }],
    ["match day, full, no teams", { isMatchDay: true, bench: 4 }, { post: "match-day-locked" }],
  ] as const)("%s", (_label, over, want) => {
    expect(org(over)).toEqual(want);
  });

  it("the squad-complete post went to them today: nothing (they never get the unpaid count alone)", () => {
    expect(org({ squadLockedToday: true, bench: 0 })).toEqual({ post: null, why: "squad-locked-today" });
  });

  it("match day with the teams made: nothing, no team sheet goes anywhere from here", () => {
    expect(org({ isMatchDay: true, teamsOut: true })).toEqual({ post: null, why: "teams-out" });
  });

  it("a monthly club's squad is the month's list in the players' group: nothing to the organisers", () => {
    expect(org({ squad: "month", open: 1 })).toEqual({ post: null, why: "month-list-in-group" });
    expect(org({ squad: "no-month", open: 1 })).toEqual({ post: null, why: "no-month-list" });
  });

  it("weekly-rhythm days and after the deadline, as the players' group", () => {
    expect(org({ weeklyRhythmDay: true, open: 2 })).toEqual({ post: null, why: "weekly-rhythm-day" });
    expect(org({ beforeDeadline: false, open: 2 })).toEqual({ post: null, why: "after-deadline" });
  });
});

/**
 * TEAMS OUT, A WEEKLY SQUAD FULL: NOTHING, ON ANY DAY (Kemal, 2026-11-05):
 * "the team poster was generated and the teams were finalised which means
 * there may be no point sharing the squad once more, it just creates
 * noise". Before this, only match day looked at the teams; the day before,
 * a full squad with a thin bench still got the roster again. Kept: match
 * day's line-ups in the players' group (the team sheet, not the squad), a
 * place open still chases, and a month's rules are their own.
 */
describe("WEEKLY, teams out and full: no squad again, whatever the day", () => {
  it.each([
    ["group, bench 0", { audience: "group", bench: 0 }],
    ["group, bench 1", { audience: "group", bench: 1 }],
    ["group, bench 2", { audience: "group", bench: 2 }],
    ["group, bench 3", { audience: "group", bench: 3 }],
    ["organisers, bench 0", { audience: "organisers", bench: 0 }],
    ["organisers, bench 1", { audience: "organisers", bench: 1 }],
    ["organisers, bench 2", { audience: "organisers", bench: 2 }],
    ["group, squad complete today", { audience: "group", bench: 1, squadLockedToday: true }],
  ] as const)("not match day, %s: teams-out", (_label, over) => {
    expect(decide({ teamsOut: true, open: 0, ...over })).toEqual({ post: null, why: "teams-out" });
  });

  it("a place open after the teams: still the chase, both audiences", () => {
    expect(decide({ teamsOut: true, open: 1 })).toEqual({ post: "chase" });
    expect(decide({ audience: "organisers", teamsOut: true, open: 1, bench: 0 })).toEqual({ post: "chase" });
  });

  it("match day still gives the players' group the line-ups, and the organisers nothing", () => {
    expect(decide({ isMatchDay: true, teamsOut: true, open: 0, bench: 1 })).toEqual({ post: "line-ups" });
    expect(decide({ audience: "organisers", isMatchDay: true, teamsOut: true, open: 0 })).toEqual({ post: null, why: "teams-out" });
  });
});

/**
 * THE DROP-OUT REMINDER (Kemal, 2026-11-05). FNF's admin group got the
 * squad and "The drop-out deadline is today at 20:30" at 17:30, with 18 of
 * 18 in, a bench of 3 and the teams already made and posted. It stays
 * quiet, to the players' group and the organisers alike, when:
 *   - the teams are made (the team sheet is the announcement), or
 *   - the squad is full with a bench of 3 or more (nothing to ask for: the
 *     same stop as the 17:00 update, `benchCovered`).
 * Otherwise it goes out as before.
 */
describe("the drop-out reminder: quiet once the week is settled", () => {
  it.each([
    ["places open, no teams", { teamsOut: false, open: 4, bench: 0 }, { send: true }],
    ["places open with a bench, no teams", { teamsOut: false, open: 1, bench: 5 }, { send: true }],
    ["full, bench 0, no teams", { teamsOut: false, open: 0, bench: 0 }, { send: true }],
    ["full, bench 2, no teams", { teamsOut: false, open: 0, bench: BENCH_THIN_BELOW - 1 }, { send: true }],
    ["full, bench 3, no teams", { teamsOut: false, open: 0, bench: BENCH_THIN_BELOW }, { send: false, why: "bench-covered" }],
    ["full, bench 6, no teams", { teamsOut: false, open: 0, bench: 6 }, { send: false, why: "bench-covered" }],
    // FNF, Thu 5 Nov 2026 17:30: 18 of 18, bench 3, teams out.
    ["FNF: full, bench 3, teams out", { teamsOut: true, open: 0, bench: 3 }, { send: false, why: "teams-out" }],
    ["teams out, bench thin", { teamsOut: true, open: 0, bench: 0 }, { send: false, why: "teams-out" }],
    ["teams out, a place open", { teamsOut: true, open: 1, bench: 0 }, { send: false, why: "teams-out" }],
  ] as const)("%s", (_label, facts, want) => {
    expect(decideDropOutReminder(facts)).toEqual(want);
  });

  it("agrees with the 17:00 stop for a full squad, teams or no teams, either audience", () => {
    for (const audience of ["group", "organisers"] as const) {
      for (const teamsOut of [false, true]) {
        for (let bench = 0; bench <= BENCH_THIN_BELOW + 2; bench++) {
          const daily = decide({ audience, teamsOut, open: 0, bench });
          const reminder = decideDropOutReminder({ teamsOut, open: 0, bench });
          expect(reminder.send).toBe(daily.post !== null);
        }
      }
    }
  });
});
