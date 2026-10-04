/**
 * CLUB FEE BILLING, slice P1: the games-played month, pure rules.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A and 10.1.
 *
 * Every case in the plan's counting table (2A.2), the played rule (2A.3),
 * the fee (2A.4) and the month boundaries (2A.1) is a fixture here. No
 * database, no network, no model.
 *
 * Calendar used below (London):
 *   November 2026: Tuesdays 3, 10, 17, 24 (four). Clocks went back on
 *     Sunday 25 Oct, so November is GMT (London = UTC).
 *   December 2026: Tuesdays 1, 8, 15, 22, 29 (five).
 */
import { describe, expect, it } from "vitest";
import {
  PAUSED_EVENT_TYPE,
  RESUMED_EVENT_TYPE,
  STRIPE_MIN_CHARGE_PENCE,
  countClubMonth,
  monthBounds,
  monthFee,
  monthIndexAt,
  pauseSpansFrom,
  type CountClubMonthInput,
  type CycleActivity,
  type CycleMatch,
} from "../club-billing-cycle-rules";
import { londonDateTimeToUtc } from "../london-time";

const L = (date: string, time = "00:00") => londonDateTimeToUtc(date, time);
const iso = (d: Date) => d.toISOString();

// ── Fixtures ────────────────────────────────────────────────────────────

const LONG_AGO = new Date("2025-01-01T00:00:00Z");

/** Sutton FC's real shape: two formats of one Tuesday game, 15 minutes apart. */
const TUE_7: CycleActivity = { id: "tue7", dayOfWeek: 2, time: "21:30", venue: "Goals Sutton", isActive: true, createdAt: LONG_AGO };
const TUE_5: CycleActivity = { id: "tue5", dayOfWeek: 2, time: "21:15", venue: "Goals Sutton", isActive: true, createdAt: LONG_AGO };
const THU_7: CycleActivity = { id: "thu7", dayOfWeek: 4, time: "20:00", venue: "Powerleague", isActive: true, createdAt: LONG_AGO };

let seq = 0;
function match(date: string, time: string, over: Partial<CycleMatch> = {}): CycleMatch {
  seq += 1;
  return {
    id: over.id ?? `m${seq}`,
    activityId: "tue7",
    date: L(date, time),
    status: "COMPLETED",
    isHistorical: false,
    redScore: null,
    yellowScore: null,
    confirmedCount: 10,
    ...over,
  };
}

/** November 2026 as a full billing month (anchor day 1). */
const NOV = { startsAt: L("2026-11-01"), endsAt: L("2026-12-01") };
/** December 2026 as a full billing month. */
const DEC = { startsAt: L("2026-12-01"), endsAt: L("2027-01-01") };

function count(over: Partial<CountClubMonthInput>) {
  return countClubMonth({
    ...NOV,
    activities: [TUE_7],
    matches: [],
    pauseSpans: [],
    tracksAttendance: true,
    ...over,
  });
}

const NOV_TUESDAYS = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"];
const DEC_TUESDAYS = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"];

// ── Month boundaries (2A.1) ─────────────────────────────────────────────

describe("monthBounds: the club's own month, London midnights, from the anchor", () => {
  it("a free month ending on the 1st gives exactly calendar months; month 1 starts at trialEndsAt itself", () => {
    const anchor = L("2026-11-01", "14:00");
    expect(monthBounds(anchor, 1)).toEqual({ startsAt: anchor, endsAt: L("2026-12-01") });
    expect(monthBounds(anchor, 2)).toEqual({ startsAt: L("2026-12-01"), endsAt: L("2027-01-01") });
    expect(monthBounds(anchor, 3)).toEqual({ startsAt: L("2027-01-01"), endsAt: L("2027-02-01") });
  });

  it("a free month ending on the 17th: 17 Oct to 17 Nov, 17 Nov to 17 Dec", () => {
    const anchor = L("2026-10-17", "09:00");
    expect(monthBounds(anchor, 1)).toEqual({ startsAt: anchor, endsAt: L("2026-11-17") });
    expect(monthBounds(anchor, 2)).toEqual({ startsAt: L("2026-11-17"), endsAt: L("2026-12-17") });
  });

  it("the 31st is clamped to a shorter month's last day and comes back after: 28 Feb, 31 Mar, 30 Apr", () => {
    const anchor = L("2027-01-31", "18:00");
    expect(monthBounds(anchor, 1).endsAt).toEqual(L("2027-02-28"));
    expect(monthBounds(anchor, 2)).toEqual({ startsAt: L("2027-02-28"), endsAt: L("2027-03-31") });
    expect(monthBounds(anchor, 3)).toEqual({ startsAt: L("2027-03-31"), endsAt: L("2027-04-30") });
    expect(monthBounds(anchor, 4).endsAt).toEqual(L("2027-05-31"));
  });

  it("computed from the anchor, never chained: month 12 of a 31st anchor ends on the 31st, month 13 on 29 Feb (leap)", () => {
    const anchor = L("2027-01-31", "18:00");
    expect(monthBounds(anchor, 12).endsAt).toEqual(L("2028-01-31"));
    expect(monthBounds(anchor, 13).endsAt).toEqual(L("2028-02-29"));
    expect(monthBounds(anchor, 14).endsAt).toEqual(L("2028-03-31"));
  });

  it("the 29th and the 30th clamp in February too", () => {
    expect(monthBounds(L("2027-01-29"), 1).endsAt).toEqual(L("2027-02-28"));
    expect(monthBounds(L("2027-01-29"), 2).endsAt).toEqual(L("2027-03-29"));
    expect(monthBounds(L("2027-01-30"), 1).endsAt).toEqual(L("2027-02-28"));
    expect(monthBounds(L("2027-01-30"), 2).endsAt).toEqual(L("2027-03-30"));
  });

  it("DST: a boundary is 00:00 LONDON, so it is 23:00 UTC the day before in summer and 00:00 UTC in winter", () => {
    // Anchor in GMT (17 Mar 2027), clocks go forward 28 Mar: month 1 ends 17 Apr 00:00 BST.
    const spring = L("2027-03-17", "12:00");
    expect(iso(monthBounds(spring, 1).endsAt)).toBe("2027-04-16T23:00:00.000Z");
    // Anchor in BST (10 Oct 2026), clocks go back 25 Oct: month 1 ends 10 Nov 00:00 GMT.
    const autumn = L("2026-10-10", "12:00");
    expect(iso(monthBounds(autumn, 1).startsAt)).toBe("2026-10-10T11:00:00.000Z");
    expect(iso(monthBounds(autumn, 1).endsAt)).toBe("2026-11-10T00:00:00.000Z");
  });

  it("the anchor's day is its LONDON date: 00:30 BST on the 1st is still the 1st (23:30 UTC on the 30th)", () => {
    const anchor = new Date("2026-09-30T23:30:00Z"); // 00:30 BST, 1 Oct
    expect(monthBounds(anchor, 1).endsAt).toEqual(L("2026-11-01"));
  });

  it("refuses an index below 1", () => {
    expect(() => monthBounds(L("2026-11-01"), 0)).toThrow();
  });
});

describe("monthIndexAt: which month an instant falls in", () => {
  const anchor = L("2027-01-31", "18:00");
  it("0 before the anchor (still in the free month)", () => {
    expect(monthIndexAt(anchor, L("2027-01-31", "17:59"))).toBe(0);
  });
  it("1 from the anchor, up to (not including) the first boundary", () => {
    expect(monthIndexAt(anchor, anchor)).toBe(1);
    expect(monthIndexAt(anchor, L("2027-02-27", "23:59"))).toBe(1);
    expect(monthIndexAt(anchor, L("2027-02-28"))).toBe(2);
  });
  it("agrees with monthBounds far out", () => {
    for (let k = 1; k <= 30; k += 1) {
      const b = monthBounds(anchor, k);
      expect(monthIndexAt(anchor, b.startsAt)).toBe(k);
      expect(monthIndexAt(anchor, new Date(b.endsAt.getTime() - 1))).toBe(k);
    }
  });
});

// ── Pause spans (2A.3) ──────────────────────────────────────────────────

describe("pauseSpansFrom: mt.paused to the next mt.resumed (or now)", () => {
  it("pairs them in time order, an open one runs to null, repeats and strays are ignored", () => {
    const spans = pauseSpansFrom([
      { type: RESUMED_EVENT_TYPE, at: L("2026-10-01") }, // stray resume first
      { type: PAUSED_EVENT_TYPE, at: L("2026-11-05") },
      { type: PAUSED_EVENT_TYPE, at: L("2026-11-06") }, // repeat while paused
      { type: RESUMED_EVENT_TYPE, at: L("2026-11-12") },
      { type: PAUSED_EVENT_TYPE, at: L("2026-11-20") },
    ]);
    expect(spans).toEqual([
      { from: L("2026-11-05"), to: L("2026-11-12") },
      { from: L("2026-11-20"), to: null },
    ]);
  });

  it("sorts its input first", () => {
    expect(
      pauseSpansFrom([
        { type: RESUMED_EVENT_TYPE, at: L("2026-11-12") },
        { type: PAUSED_EVENT_TYPE, at: L("2026-11-05") },
      ]),
    ).toEqual([{ from: L("2026-11-05"), to: L("2026-11-12") }]);
  });

  it("the event type names are the ones the plan fixes", () => {
    expect(PAUSED_EVENT_TYPE).toBe("mt.paused");
    expect(RESUMED_EVENT_TYPE).toBe("mt.resumed");
  });
});

// ── Counting (2A.2, 2A.3) ───────────────────────────────────────────────

describe("countClubMonth: scheduled and played", () => {
  it("Kemal's 3 of 4: four Tuesdays, three played", () => {
    const r = count({
      matches: [
        match("2026-11-03", "21:30"),
        match("2026-11-10", "21:30"),
        match("2026-11-17", "21:30"),
        match("2026-11-24", "21:30", { status: "CANCELLED", confirmedCount: 0 }),
      ],
    });
    expect([r.played, r.scheduled]).toEqual([3, 4]);
    expect(monthFee({ priceAtStartPence: 999, played: r.played, scheduled: r.scheduled }).amountPence).toBe(749);
  });

  it("Kemal's 4 of 5: five Tuesdays in December, four played", () => {
    const r = count({
      ...DEC,
      matches: DEC_TUESDAYS.map((d, i) => match(d, "21:30", i === 2 ? { status: "CANCELLED" } : {})),
    });
    expect([r.played, r.scheduled]).toEqual([4, 5]);
    expect(monthFee({ priceAtStartPence: 999, played: r.played, scheduled: r.scheduled }).amountPence).toBe(799);
  });

  it("Kemal's 0 of 4: every week cancelled, nothing to charge", () => {
    const r = count({ matches: NOV_TUESDAYS.map((d) => match(d, "21:30", { status: "CANCELLED" })) });
    expect([r.played, r.scheduled]).toEqual([0, 4]);
    expect(monthFee({ priceAtStartPence: 999, played: 0, scheduled: 4 })).toMatchObject({ amountPence: 0, charge: false, outcome: "no-games" });
  });

  it("a cancelled week is scheduled, not played, and says why", () => {
    const r = count({ matches: [match("2026-11-10", "21:30", { id: "c", status: "CANCELLED" })] });
    expect(r.scheduled).toBe(4);
    expect(r.played).toBe(0);
    expect(r.games.find((g) => g.matchIds.includes("c"))).toMatchObject({ played: false, outcome: "cancelled" });
  });

  it("an ended match nobody said IN to and nobody scored (auto COMPLETED) is not played", () => {
    const r = count({ matches: [match("2026-11-10", "21:30", { id: "ns", confirmedCount: 0 })] });
    expect(r.played).toBe(0);
    expect(r.games.find((g) => g.matchIds.includes("ns"))).toMatchObject({ played: false, outcome: "nobody-in" });
  });

  it("an ended match with a score and no IN list is played (score-only)", () => {
    const r = count({ matches: [match("2026-11-10", "21:30", { id: "s", confirmedCount: 0, redScore: 3, yellowScore: 2 })] });
    expect(r.played).toBe(1);
    expect(r.games.find((g) => g.matchIds.includes("s"))).toMatchObject({ played: true, evidence: "score" });
  });

  it("half a score is not a score", () => {
    const r = count({ matches: [match("2026-11-10", "21:30", { confirmedCount: 0, redScore: 3, yellowScore: null })] });
    expect(r.played).toBe(0);
  });

  it("an IN is evidence: played with evidence 'in'", () => {
    const r = count({ matches: [match("2026-11-10", "21:30", { id: "i", confirmedCount: 1 })] });
    expect(r.games.find((g) => g.matchIds.includes("i"))).toMatchObject({ played: true, evidence: "in" });
  });

  it("a club that does not track IN (MoM only): any ended match counts", () => {
    const r = count({
      tracksAttendance: false,
      matches: [match("2026-11-10", "21:30", { id: "mom", confirmedCount: 0 }), match("2026-11-17", "21:30", { status: "CANCELLED", confirmedCount: 0 })],
    });
    expect(r.played).toBe(1);
    expect(r.scheduled).toBe(4);
    expect(r.games.find((g) => g.matchIds.includes("mom"))).toMatchObject({ played: true, evidence: "no-attendance-tracking" });
  });

  it("an open match (not COMPLETED) is not played", () => {
    for (const status of ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]) {
      const r = count({ matches: [match("2026-11-10", "21:30", { status })] });
      expect(r.played).toBe(0);
    }
  });

  it("Sutton FC's shape: a 7-a-side (21:30) and 5-a-side (21:15) pair is ONE weekly game, never two", () => {
    const r = count({ activities: [TUE_7, TUE_5], matches: [] });
    expect(r.scheduled).toBe(4);
  });

  it("the calendar game sits at the slot's EARLIEST kickoff", () => {
    const r = count({ activities: [TUE_7, TUE_5] });
    expect(iso(r.games[0].kickoff)).toBe(iso(L("2026-11-03", "21:15")));
  });

  it("a format-switch pair in one week (real match plus ghost) is one game, played if either row was", () => {
    const r = count({
      activities: [TUE_7, TUE_5],
      matches: [
        match("2026-11-10", "21:15", { id: "real", activityId: "tue5" }),
        match("2026-11-10", "21:30", { id: "ghost", activityId: "tue7", confirmedCount: 0 }),
      ],
    });
    expect([r.played, r.scheduled]).toEqual([1, 4]);
    const g = r.games.find((x) => x.matchIds.includes("real"));
    expect(g?.matchIds.sort()).toEqual(["ghost", "real"]);
  });

  it("a ghost pair OFF the calendar (an extra Saturday friendly in two formats) is one extra game: venue + weekday + kickoff within 90 min", () => {
    const r = count({
      activities: [TUE_7, TUE_5],
      matches: [
        match("2026-11-14", "11:00", { id: "satA", activityId: "tue7" }),
        match("2026-11-14", "12:20", { id: "satB", activityId: "tue5", confirmedCount: 0 }),
      ],
    });
    expect([r.played, r.scheduled]).toEqual([1, 5]);
    expect(r.games.filter((g) => g.source === "extra")).toHaveLength(1);
  });

  it("two extra matches at the same weekday and time but different venues are two games", () => {
    // A second Tuesday game at another venue, 2.5 hours earlier: its own slot.
    const tueEarly: CycleActivity = { id: "tueE", dayOfWeek: 2, time: "19:00", venue: "Elsewhere", isActive: true, createdAt: LONG_AGO };
    const r = count({
      activities: [TUE_7, tueEarly],
      matches: [match("2026-11-14", "11:00", { id: "x1", activityId: "tue7" }), match("2026-11-14", "11:00", { id: "x2", activityId: "tueE" })],
    });
    expect(r.games.filter((g) => g.source === "extra")).toHaveLength(2);
    expect(r.scheduled).toBe(10); // 4 + 4 Tuesdays, 2 Saturday extras
  });

  it("an inactive activity with a match this month brings its weekly calendar, and a match on that calendar is that game", () => {
    const sat: CycleActivity = { id: "sat", dayOfWeek: 6, time: "11:00", venue: "Elsewhere", isActive: false, createdAt: LONG_AGO };
    const r = count({
      activities: [TUE_7, sat],
      matches: [match("2026-11-14", "11:00", { id: "x1", activityId: "tue7" }), match("2026-11-14", "11:30", { id: "x2", activityId: "sat" })],
    });
    // 4 Tuesdays + 4 Saturdays; both Saturday rows are within 90 minutes of
    // the 14 Nov calendar game on its weekday, so they ARE that game.
    expect(r.scheduled).toBe(8);
    expect(r.played).toBe(1);
  });

  it("matches more than 90 minutes apart on the same day are two games", () => {
    const r = count({
      matches: [match("2026-11-14", "10:00", { id: "early" }), match("2026-11-14", "11:31", { id: "late" })],
    });
    expect(r.scheduled).toBe(6);
    expect(r.played).toBe(2);
  });

  it("two weekly games (Tuesday and Thursday) are summed: 4 + 4 in November", () => {
    const r = count({
      activities: [TUE_7, THU_7],
      matches: [
        ...NOV_TUESDAYS.map((d) => match(d, "21:30")),
        match("2026-11-05", "20:00", { activityId: "thu7" }),
        match("2026-11-12", "20:00", { activityId: "thu7" }),
        match("2026-11-19", "20:00", { activityId: "thu7", status: "CANCELLED" }),
      ],
    });
    expect([r.played, r.scheduled]).toEqual([6, 8]);
    expect(monthFee({ priceAtStartPence: 999, played: 6, scheduled: 8 }).amountPence).toBe(749);
  });

  it("7 of 9 with two weekly games is 777p", () => {
    expect(monthFee({ priceAtStartPence: 999, played: 7, scheduled: 9 }).amountPence).toBe(777);
  });

  it("an extra one-off match adds one scheduled game", () => {
    const r = count({ matches: [...NOV_TUESDAYS.map((d) => match(d, "21:30")), match("2026-11-21", "10:00", { id: "friendly" })] });
    expect([r.played, r.scheduled]).toEqual([5, 5]);
    expect(r.games.find((g) => g.matchIds.includes("friendly"))?.source).toBe("extra");
  });

  it("a week deleted as an empty shell (no match row) on the calendar is scheduled, not played", () => {
    const r = count({ matches: NOV_TUESDAYS.slice(0, 3).map((d) => match(d, "21:30")) });
    expect([r.played, r.scheduled]).toEqual([3, 4]);
    expect(r.games.find((g) => iso(g.kickoff) === iso(L("2026-11-24", "21:30")))).toMatchObject({ played: false, outcome: "no-match", matchIds: [] });
  });

  it("paused weeks: no match rows were generated; the calendar still schedules them, not played, outcome 'paused'", () => {
    const r = count({
      matches: [match("2026-11-03", "21:30"), match("2026-11-24", "21:30")],
      pauseSpans: [{ from: L("2026-11-05"), to: L("2026-11-20") }],
    });
    expect([r.played, r.scheduled]).toEqual([2, 4]);
    expect(r.games.filter((g) => g.outcome === "paused")).toHaveLength(2);
  });

  it("a match completed quietly by the resume (kicked off inside a pause span) is not played", () => {
    const r = count({
      matches: [match("2026-11-10", "21:30", { id: "quiet", confirmedCount: 6 })],
      pauseSpans: [{ from: L("2026-11-09"), to: L("2026-11-11") }],
    });
    expect(r.played).toBe(0);
    expect(r.games.find((g) => g.matchIds.includes("quiet"))).toMatchObject({ played: false, outcome: "paused" });
  });

  it("an open pause span (still paused) covers everything after it", () => {
    const r = count({
      matches: [match("2026-11-03", "21:30"), match("2026-11-24", "21:30")],
      pauseSpans: [{ from: L("2026-11-15"), to: null }],
    });
    expect(r.played).toBe(1);
  });

  it("a match exactly at the resume instant is outside the span (span is [from, to))", () => {
    const r = count({
      matches: [match("2026-11-10", "21:30")],
      pauseSpans: [{ from: L("2026-11-09"), to: L("2026-11-10", "21:30") }],
    });
    expect(r.played).toBe(1);
  });

  it("a summer break with the activity left active and no games: 0 of 4, nothing to charge", () => {
    const r = count({ matches: [] });
    expect([r.played, r.scheduled]).toEqual([0, 4]);
    expect(monthFee({ priceAtStartPence: 999, played: 0, scheduled: 4 }).charge).toBe(false);
  });

  it("a summer break with the activity switched off and no matches: 0 of 0, nothing to charge", () => {
    const r = count({ activities: [{ ...TUE_7, isActive: false }], matches: [] });
    expect([r.played, r.scheduled]).toEqual([0, 0]);
    expect(monthFee({ priceAtStartPence: 999, played: 0, scheduled: 0 })).toMatchObject({ amountPence: 0, charge: false, outcome: "no-games" });
  });

  it("a club with no activities at all: 0 of 0", () => {
    expect(count({ activities: [] })).toMatchObject({ played: 0, scheduled: 0, games: [] });
  });

  it("a weekly game switched off mid month that had a match this month: the whole month's weeks of it", () => {
    const r = count({ activities: [{ ...TUE_7, isActive: false }], matches: [match("2026-11-03", "21:30")] });
    expect([r.played, r.scheduled]).toEqual([1, 4]);
  });

  it("a new weekly game started mid month counts its weeks from the activity's createdAt", () => {
    const r = count({ activities: [{ ...TUE_7, createdAt: L("2026-11-12", "09:00") }], matches: [] });
    expect(r.scheduled).toBe(2); // 17 and 24 Nov
  });

  it("an activity created on match day before kickoff schedules that day's game", () => {
    const r = count({ activities: [{ ...TUE_7, createdAt: L("2026-11-10", "09:00") }], matches: [] });
    expect(r.scheduled).toBe(3); // 10, 17, 24 Nov
  });

  it("a match moved across the boundary (Tue 24 Nov to Thu 3 Dec): Nov keeps the Tuesday (not played), Dec adds the Thursday", () => {
    const moved = match("2026-12-03", "21:30", { id: "moved" });
    const nov = count({ matches: [...NOV_TUESDAYS.slice(0, 3).map((d) => match(d, "21:30")), moved] });
    expect([nov.played, nov.scheduled]).toEqual([3, 4]); // moved is not in November
    const dec = count({ ...DEC, matches: [...DEC_TUESDAYS.map((d) => match(d, "21:30")), moved] });
    expect([dec.played, dec.scheduled]).toEqual([6, 6]); // the Thursday adds one
  });

  it("a synthetic historical match is never counted, either way", () => {
    const r = count({
      activities: [{ ...TUE_7, isActive: false }],
      matches: [match("2026-11-10", "21:30", { isHistorical: true }), match("2026-11-14", "10:00", { isHistorical: true })],
    });
    expect([r.played, r.scheduled]).toEqual([0, 0]);
  });

  it("kickoff exactly at startsAt is in; exactly at endsAt is out", () => {
    const sun: CycleActivity = { id: "sun", dayOfWeek: 0, time: "00:00", venue: "V", isActive: false, createdAt: LONG_AGO };
    const r = count({
      activities: [sun],
      matches: [match("2026-11-01", "00:00", { id: "start", activityId: "sun" }), match("2026-12-01", "00:00", { id: "end", activityId: "sun" })],
    });
    const ids = r.games.flatMap((g) => g.matchIds);
    expect(ids).toContain("start");
    expect(ids).not.toContain("end");
    expect(r.scheduled).toBe(5); // Sundays 1, 8, 15, 22, 29 Nov
  });

  it("month 1 starts at trialEndsAt (14:00 on Tue 3 Nov): that evening's game is in, a morning one would not be", () => {
    const r = count({ startsAt: L("2026-11-03", "14:00"), endsAt: L("2026-12-03"), matches: [match("2026-11-03", "21:30"), match("2026-11-03", "10:00", { id: "morning" })] });
    expect(r.games.flatMap((g) => g.matchIds)).not.toContain("morning");
    expect(r.scheduled).toBe(5); // 3, 10, 17, 24 Nov and 1 Dec
  });

  it("DST month: a club's month across the October clock change keeps the 21:30 London kickoff on both sides", () => {
    // 17 Oct (BST) to 17 Nov (GMT): Tuesdays 20, 27 Oct, 3, 10 Nov.
    const r = count({
      startsAt: L("2026-10-17"),
      endsAt: L("2026-11-17"),
      matches: [match("2026-10-20", "21:30"), match("2026-10-27", "21:30"), match("2026-11-03", "21:30"), match("2026-11-10", "21:30")],
    });
    expect([r.played, r.scheduled]).toEqual([4, 4]);
    expect(r.games.every((g) => g.matchIds.length === 1 && g.source === "weekly")).toBe(true);
  });

  it("a month starting on the 31st clamped into February counts February's weeks only", () => {
    // 31 Jan 2027 anchor, month 1 = 31 Jan 18:00 to 28 Feb 00:00. Tuesdays: 2, 9, 16, 23 Feb.
    const anchor = L("2027-01-31", "18:00");
    const r = count({ ...monthBounds(anchor, 1), matches: [] });
    expect(r.scheduled).toBe(4);
    // Month 2 = 28 Feb to 31 Mar: Tuesdays 2, 9, 16, 23, 30 Mar.
    expect(count({ ...monthBounds(anchor, 2), matches: [] }).scheduled).toBe(5);
  });

  it("Kemal's mute does not exist here: nothing about whatsappBotEnabled is an input (counted as normal)", () => {
    const r = count({ matches: NOV_TUESDAYS.map((d) => match(d, "21:30")) });
    expect([r.played, r.scheduled]).toEqual([4, 4]);
  });

  it("played never exceeds scheduled, and every played game is a scheduled one", () => {
    const r = count({
      activities: [TUE_7, TUE_5, THU_7],
      matches: [
        ...NOV_TUESDAYS.flatMap((d) => [match(d, "21:30"), match(d, "21:15", { activityId: "tue5" })]),
        match("2026-11-21", "10:00"),
        match("2026-11-21", "10:30"),
      ],
    });
    expect(r.played).toBeLessThanOrEqual(r.scheduled);
    expect(r.games.filter((g) => g.played)).toHaveLength(r.played);
    expect(r.games).toHaveLength(r.scheduled);
  });

  it("games are listed in kickoff order", () => {
    const r = count({ activities: [TUE_7, THU_7], matches: [match("2026-11-21", "10:00")] });
    const times = r.games.map((g) => g.kickoff.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("with `now` inside the month, games still to come are 'upcoming' and counted apart (for the page)", () => {
    const r = count({ matches: [match("2026-11-03", "21:30"), match("2026-11-10", "21:30")], now: L("2026-11-12") });
    expect(r).toMatchObject({ played: 2, scheduled: 4, upcoming: 2 });
    expect(r.games.filter((g) => g.outcome === "upcoming")).toHaveLength(2);
  });

  it("without `now`, nothing is upcoming (the month is being closed)", () => {
    expect(count({}).upcoming).toBe(0);
  });
});

// ── The fee (2A.4) ──────────────────────────────────────────────────────

describe("monthFee: price x played / scheduled, rounded DOWN to the penny", () => {
  const fee = (played: number, scheduled: number, price = 999, close?: number | null) =>
    monthFee({ priceAtStartPence: price, priceAtClosePence: close, played, scheduled });

  it("the plan's table, Standard GBP 9.99", () => {
    expect(fee(3, 4).amountPence).toBe(749); // 749.25
    expect(fee(4, 5).amountPence).toBe(799); // 799.2
    expect(fee(4, 4).amountPence).toBe(999);
    expect(fee(5, 5).amountPence).toBe(999);
    expect(fee(2, 4).amountPence).toBe(499); // 499.5: floor, not 500
    expect(fee(1, 5).amountPence).toBe(199); // 199.8
    expect(fee(7, 9).amountPence).toBe(777);
  });

  it("a full month is charged as a charge", () => {
    expect(fee(4, 4)).toEqual({ pricePence: 999, amountPence: 999, charge: true, outcome: "charge" });
  });

  it("0 played or 0 scheduled: nothing", () => {
    expect(fee(0, 4)).toEqual({ pricePence: 999, amountPence: 0, charge: false, outcome: "no-games" });
    expect(fee(0, 0)).toEqual({ pricePence: 999, amountPence: 0, charge: false, outcome: "no-games" });
  });

  it("Custom is a monthly maximum and scales the same way: GBP 5, 3 of 4 is GBP 3.75", () => {
    expect(fee(3, 4, 500).amountPence).toBe(375);
  });

  it("under 30p is not charged (Custom GBP 1, 1 of 5 is 20p); 29p no, 30p yes", () => {
    expect(STRIPE_MIN_CHARGE_PENCE).toBe(30);
    expect(fee(1, 5, 100)).toEqual({ pricePence: 100, amountPence: 20, charge: false, outcome: "below-minimum" });
    expect(fee(1, 5, 145)).toMatchObject({ amountPence: 29, charge: false, outcome: "below-minimum" });
    expect(fee(1, 5, 150)).toMatchObject({ amountPence: 30, charge: true, outcome: "charge" });
  });

  it("Standard never falls under the minimum: one game of fifteen is 66p", () => {
    expect(fee(1, 15)).toMatchObject({ amountPence: 66, charge: true });
  });

  it("the lower of the price at the start and at the close", () => {
    expect(fee(3, 4, 999, 500)).toMatchObject({ pricePence: 500, amountPence: 375 });
    expect(fee(3, 4, 500, 999)).toMatchObject({ pricePence: 500, amountPence: 375 });
    expect(fee(3, 4, 999, null)).toMatchObject({ pricePence: 999, amountPence: 749 });
  });

  it("never above the price, for every played/scheduled up to 15", () => {
    for (let s = 1; s <= 15; s += 1) {
      for (let p = 0; p <= s; p += 1) {
        const f = fee(p, s);
        expect(f.amountPence).toBeLessThanOrEqual(999);
        expect(f.amountPence).toBeLessThanOrEqual((999 * p) / s);
        expect(Number.isInteger(f.amountPence)).toBe(true);
      }
    }
  });

  it("refuses impossible counts (played above scheduled, negatives, fractions)", () => {
    expect(() => fee(5, 4)).toThrow();
    expect(() => fee(-1, 4)).toThrow();
    expect(() => fee(1.5, 4)).toThrow();
    expect(() => fee(1, 4, -1)).toThrow();
  });
});
