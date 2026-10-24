/**
 * ROLLING SQUAD OVER A CANCELLED WEEK (2026-10-24, Kemal, after FNF).
 *
 * FNF's Fri 23 Oct was cancelled on the 22nd. Before that, players had
 * said OUT for it. The Fri 30 Oct seed copied the 16 Oct squad whole, so
 * Hamzah had to take the OUTs off by hand ("Who dropped out last week?
 * They're not going to be on the list this week").
 *
 * The rule, in `applyCancelledWeeks` (pure):
 *   - a carried player whose last statement on a cancelled week of the
 *     fixture BEFORE it was cancelled was an OUT (CONFIRMED or BENCH ->
 *     DROPPED) is left out, and named;
 *   - a player who said IN for the cancelled week (CONFIRMED there) but
 *     was not in last played squad is carried too, after it, as the
 *     latest intent;
 *   - what happened after the cancellation, the seed's own rows, merges
 *     and format recuts are not statements.
 */
import { describe, it, expect } from "vitest";
import {
  applyCancelledWeeks,
  cancelledWeekIntents,
  decideSeed,
  type CancelledWeek,
  type CancelledWeekEvent,
  type SeedSourceRow,
} from "../rolling-squad-rules";

const CANCELLED_AT = new Date("2026-10-22T15:40:00.000Z");
const before = (mins: number) => new Date(CANCELLED_AT.getTime() - mins * 60 * 1000);
const after = (mins: number) => new Date(CANCELLED_AT.getTime() + mins * 60 * 1000);

function row(userId: string, position: number, over: Partial<SeedSourceRow> = {}): SeedSourceRow {
  return {
    userId,
    status: "CONFIRMED",
    position,
    phoneNumber: `+4477009${position.toString().padStart(5, "0")}`,
    email: `${userId}@e2e.test`,
    isActive: true,
    membership: { leftAt: null, provisionallyAddedAt: null },
    ...over,
  };
}

function ev(userId: string, from: string | null, to: string | null, at: Date, cause = "self-attendance", toPosition: number | null = 1): CancelledWeekEvent {
  return { userId, fromStatus: from, toStatus: to, cause, at, toPosition };
}

function week(events: CancelledWeekEvent[], over: Partial<CancelledWeek> = {}): CancelledWeek {
  return { date: new Date("2026-10-23T19:30:00.000Z"), cancelledAt: CANCELLED_AT, events, ...over };
}

describe("cancelledWeekIntents", () => {
  it("CONFIRMED -> DROPPED and BENCH -> DROPPED before the cancellation are OUT", () => {
    const i = cancelledWeekIntents([
      week([
        ev("yaseen", null, "CONFIRMED", before(3000), "rolling-squad"),
        ev("yaseen", "CONFIRMED", "DROPPED", before(2000), "admin-message"),
        ev("najib", null, "BENCH", before(1500), "admin-message"),
        ev("najib", "BENCH", "DROPPED", before(1000)),
      ]),
    ]);
    expect(i.get("yaseen")?.intent).toBe("out");
    expect(i.get("najib")?.intent).toBe("out");
  });

  it("the LAST statement before the cancellation wins: OUT then back IN is IN", () => {
    const i = cancelledWeekIntents([
      week([
        ev("hamzah", null, "BENCH", before(3000), "admin-message"),
        ev("hamzah", "BENCH", "DROPPED", before(2900)),
        ev("hamzah", "DROPPED", "CONFIRMED", before(2000), "admin-message", 28),
      ]),
    ]);
    expect(i.get("hamzah")).toEqual({ intent: "in", position: 28 });
  });

  it("anything at or after the cancellation is not a statement", () => {
    const i = cancelledWeekIntents([
      week([
        ev("mo", null, "CONFIRMED", before(3000), "rolling-squad"),
        ev("mo", "CONFIRMED", "DROPPED", after(5)),
        ev("imti", null, "CONFIRMED", after(10), "admin-message"),
      ]),
    ]);
    expect(i.has("mo")).toBe(false);
    expect(i.has("imti")).toBe(false);
  });

  it("the seed's own rows, merges and format recuts are not statements", () => {
    const i = cancelledWeekIntents([
      week([
        ev("bilal", null, "CONFIRMED", before(3000), "rolling-squad"),
        ev("seb", "CONFIRMED", "DROPPED", before(2000), "player-merge"),
        ev("maj", "CONFIRMED", "BENCH", before(1000), "format-switch"),
      ]),
    ]);
    expect(i.size).toBe(0);
  });

  it("a row removed outright, or left on the bench, says neither IN nor OUT", () => {
    const i = cancelledWeekIntents([
      week([
        ev("wasim", "CONFIRMED", null, before(2000), "admin-squad-edit"),
        ev("glazers", null, "BENCH", before(1000)),
      ]),
    ]);
    expect(i.size).toBe(0);
  });

  it("two cancelled weeks: the later week's statement wins", () => {
    const i = cancelledWeekIntents([
      week([ev("kieran", "CONFIRMED", "DROPPED", before(9000))], { date: new Date("2026-10-23T19:30:00Z") }),
      week([ev("kieran", null, "CONFIRMED", before(100))], { date: new Date("2026-10-30T20:30:00Z") }),
    ]);
    expect(i.get("kieran")?.intent).toBe("in");
  });
});

describe("applyCancelledWeeks", () => {
  const source = [row("bilal", 1), row("mo", 3), row("seb", 4), row("feroz", 9), row("najib", 6, { status: "DROPPED" })];

  it("no cancelled week: the source rows, untouched, and nobody left out", () => {
    expect(applyCancelledWeeks({ sourceRows: source, weeks: [], cancelledWeekRows: [] })).toEqual({
      rows: source,
      leftOut: [],
    });
  });

  it("FNF 23 Oct: the players who said OUT for the cancelled week are left out, in last week's order", () => {
    const res = applyCancelledWeeks({
      sourceRows: source,
      weeks: [
        week([
          ev("feroz", "CONFIRMED", "DROPPED", before(4000), "admin-message"),
          ev("mo", "CONFIRMED", "DROPPED", before(4001), "admin-message"),
        ]),
      ],
      cancelledWeekRows: [],
    });
    expect(res.leftOut).toEqual(["mo", "feroz"]);
    expect(decideSeed({ sourceRows: res.rows, targetRows: [], maxPlayers: 18 }).map((d) => d.userId)).toEqual([
      "bilal",
      "seb",
    ]);
  });

  it("a player who said IN for the cancelled week is carried after last week's squad, in that week's order", () => {
    const res = applyCancelledWeeks({
      sourceRows: source,
      weeks: [
        week([
          ev("clarence", null, "CONFIRMED", before(3000), "admin-message", 26),
          ev("imti", null, "CONFIRMED", before(5000), "admin-message", 19),
          // Najib was DROPPED on last week's match and picked for this one.
          ev("najib", "BENCH", "CONFIRMED", before(4000), "organiser-pick", 24),
        ]),
      ],
      cancelledWeekRows: [row("clarence", 26), row("imti", 19), row("najib", 24)],
    });
    expect(res.leftOut).toEqual([]);
    const seeded = decideSeed({ sourceRows: res.rows, targetRows: [], maxPlayers: 18 });
    expect(seeded.map((d) => d.userId)).toEqual(["bilal", "mo", "seb", "feroz", "imti", "najib", "clarence"]);
    expect(seeded.slice(4).every((d) => d.status === "CONFIRMED")).toBe(true);
    expect(seeded[4].note).toBe("carried over (IN for the cancelled week)");
    expect(seeded[0].note).toBe("carried over");
  });

  it("a cancelled-week IN who would not be carried anyway (left the group, partner guest) is not", () => {
    const res = applyCancelledWeeks({
      sourceRows: source,
      weeks: [week([ev("lee", null, "CONFIRMED", before(10), "self-attendance", 30), ev("pg", null, "CONFIRMED", before(10), "partner-ask", 31)])],
      cancelledWeekRows: [
        row("lee", 30, { membership: { leftAt: before(5), provisionallyAddedAt: null } }),
        row("pg", 31, { membership: { leftAt: null, provisionallyAddedAt: null, guestFromOrgId: "org-other" } }),
      ],
    });
    expect(decideSeed({ sourceRows: res.rows, targetRows: [], maxPlayers: 18 }).map((d) => d.userId)).toEqual([
      "bilal",
      "mo",
      "seb",
      "feroz",
    ]);
  });

  it("an OUT for the cancelled week from someone who was not carried anyway names nobody", () => {
    const res = applyCancelledWeeks({
      sourceRows: source,
      weeks: [week([ev("najib", "CONFIRMED", "DROPPED", before(10)), ev("raihan", "CONFIRMED", "DROPPED", before(10))])],
      cancelledWeekRows: [],
    });
    expect(res.leftOut).toEqual([]);
  });

  it("a left-out player who already has a row on the target keeps it (decideSeed leaves it alone)", () => {
    const res = applyCancelledWeeks({
      sourceRows: source,
      weeks: [week([ev("mo", "CONFIRMED", "DROPPED", before(10))])],
      cancelledWeekRows: [],
    });
    expect(res.leftOut).toEqual(["mo"]);
    const seeded = decideSeed({ sourceRows: res.rows, targetRows: [{ userId: "mo", status: "CONFIRMED" }], maxPlayers: 18 });
    expect(seeded.map((d) => d.userId)).toEqual(["bilal", "seb", "feroz"]);
  });
});
