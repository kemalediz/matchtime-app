/**
 * Monthly squad, slice 2 (MDs/monthly-squad-plan-2026-10-05.md, sections
 * 3 and 4.5): the pure rules. Settings validation, the month's calendar,
 * and the plan for starting a month part-way through from the organiser's
 * own list. No database, no model, nothing posts.
 *
 * Every name is made up.
 */
import { describe, it, expect } from "vitest";
import {
  amountDuePence,
  draftSeedFromList,
  gamesPlayedBy,
  londonMonthStart,
  monthFixtureDates,
  normaliseCreditRule,
  normaliseSquadMode,
  parsePounds,
  planMonthSeed,
  prepareMonthlySquadPatch,
  type MonthSeedInput,
  type SeedListInput,
} from "../squad-month-rules";
import { parseMonthlyList } from "../monthly-list";

describe("normalisers", () => {
  it("anything that is not 'monthly' reads as weekly, today's behaviour", () => {
    expect(normaliseSquadMode("monthly")).toBe("monthly");
    for (const v of ["weekly", "", "MONTHLY", "month", null, undefined, 1]) {
      expect(normaliseSquadMode(v)).toBe("weekly");
    }
  });

  it("an unknown credit rule reads as the default, any-miss", () => {
    expect(normaliseCreditRule("filled-only")).toBe("filled-only");
    expect(normaliseCreditRule("none")).toBe("none");
    expect(normaliseCreditRule("whatever")).toBe("any-miss");
    expect(normaliseCreditRule(null)).toBe("any-miss");
  });
});

describe("prepareMonthlySquadPatch", () => {
  it("switching to monthly also turns the rolling squad off", () => {
    expect(prepareMonthlySquadPatch({ squadMode: "monthly" })).toEqual({
      ok: true,
      data: { squadMode: "monthly", rollingSquadEnabled: false },
      keys: ["squadMode"],
    });
  });

  it("switching back to weekly leaves the rolling squad alone", () => {
    expect(prepareMonthlySquadPatch({ squadMode: "weekly" })).toEqual({
      ok: true,
      data: { squadMode: "weekly" },
      keys: ["squadMode"],
    });
  });

  it("accepts every setting at once", () => {
    const r = prepareMonthlySquadPatch({
      paygPricePence: 800,
      monthListOpensDaysBefore: 10,
      monthCreditRule: "filled-only",
      paymentInstructions: "  Bank details are in the group description.  ",
    });
    expect(r).toEqual({
      ok: true,
      data: {
        paygPricePence: 800,
        monthListOpensDaysBefore: 10,
        monthCreditRule: "filled-only",
        paymentInstructions: "Bank details are in the group description.",
      },
      keys: ["paygPricePence", "monthListOpensDaysBefore", "monthCreditRule", "paymentInstructions"],
    });
  });

  it("an empty price or empty instructions clears the setting", () => {
    expect(prepareMonthlySquadPatch({ paygPricePence: null, paymentInstructions: "   " })).toMatchObject({
      ok: true,
      data: { paygPricePence: null, paymentInstructions: null },
    });
  });

  it.each([
    [{ squadMode: "yearly" }, "bad-mode"],
    [{ paygPricePence: 0 }, "bad-price"],
    [{ paygPricePence: -5 }, "bad-price"],
    [{ paygPricePence: 7.5 }, "bad-price"],
    [{ paygPricePence: 10001 }, "bad-price"],
    [{ monthListOpensDaysBefore: 0 }, "bad-days"],
    [{ monthListOpensDaysBefore: 29 }, "bad-days"],
    [{ monthListOpensDaysBefore: 2.5 }, "bad-days"],
    [{ monthCreditRule: "sometimes" }, "bad-rule"],
    [{ paymentInstructions: "x".repeat(501) }, "too-long"],
    [{ paymentInstructions: 12 }, "too-long"],
    [{}, "empty"],
    [null, "empty"],
    [{ somethingElse: true }, "empty"],
  ])("refuses %j with %s", (patch, error) => {
    expect(prepareMonthlySquadPatch(patch as never)).toEqual({ ok: false, error });
  });

  it("one bad key refuses the whole patch: nothing is half saved", () => {
    expect(prepareMonthlySquadPatch({ squadMode: "monthly", paygPricePence: -1 })).toEqual({
      ok: false,
      error: "bad-price",
    });
  });

  it("strips control characters from the instructions and keeps line breaks", () => {
    const r = prepareMonthlySquadPatch({ paymentInstructions: "Pay Sam\u0000 by bank.\nRef: your name" });
    expect(r).toMatchObject({ ok: true, data: { paymentInstructions: "Pay Sam by bank.\nRef: your name" } });
  });
});

describe("parsePounds", () => {
  it.each([
    ["8", 800],
    ["7.50", 750],
    ["7.5", 750],
    ["£22.50", 2250],
    [" 30 ", 3000],
    ["0.5", 50],
  ])("%s", (text, pence) => {
    expect(parsePounds(text)).toBe(pence);
  });

  it.each([[""], ["   "], ["abc"], ["7.555"], ["-3"], ["1,000"], ["7,50"]])("%j is not an amount", (text) => {
    expect(parsePounds(text)).toBeNull();
  });
});

describe("the month's calendar", () => {
  it("the London month a moment falls in", () => {
    expect(londonMonthStart(new Date("2026-10-05T12:00:00Z"))).toBe("2026-10-01");
    // 23:30 UTC on 31 October is 23:30 London (GMT): still October.
    expect(londonMonthStart(new Date("2026-10-31T23:30:00Z"))).toBe("2026-10-01");
    // 23:30 UTC on 30 June is 00:30 London on 1 July (BST).
    expect(londonMonthStart(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
  });

  it("October 2026 has four Mondays", () => {
    expect(monthFixtureDates("2026-10-01", 1)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  });

  it("November 2026 has five Mondays", () => {
    expect(monthFixtureDates("2026-11-01", 1)).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
    ]);
  });

  it("a month that starts on the fixture's day includes the 1st", () => {
    expect(monthFixtureDates("2026-10-01", 4)[0]).toBe("2026-10-01");
    expect(monthFixtureDates("2026-02-01", 0)).toHaveLength(4);
  });

  it("refuses anything that is not the 1st or not a weekday", () => {
    expect(() => monthFixtureDates("2026-10-05", 1)).toThrow();
    expect(() => monthFixtureDates("2026-10-01", 7)).toThrow();
  });

  it("a game counts as played once its London kick-off has passed", () => {
    const dates = monthFixtureDates("2026-10-01", 1);
    // Tuesday 6 October: the 5th was played.
    expect(gamesPlayedBy(dates, "20:00", new Date("2026-10-06T09:00:00Z"))).toBe(1);
    // Monday 12 October, 19:30 London (18:30 UTC): the second has not kicked off.
    expect(gamesPlayedBy(dates, "20:00", new Date("2026-10-12T18:30:00Z"))).toBe(1);
    // 20:30 London the same evening: it has.
    expect(gamesPlayedBy(dates, "20:00", new Date("2026-10-12T19:30:00Z"))).toBe(2);
    expect(gamesPlayedBy(dates, "20:00", new Date("2026-10-01T09:00:00Z"))).toBe(0);
    expect(gamesPlayedBy(dates, "20:00", new Date("2026-11-01T09:00:00Z"))).toBe(4);
  });

  it("a fixture time that cannot be read counts no games rather than breaking the page", () => {
    expect(gamesPlayedBy(monthFixtureDates("2026-10-01", 1), "8pm", new Date("2026-10-20T09:00:00Z"))).toBe(0);
  });
});

describe("amountDuePence", () => {
  it("share x (games - credits), from the plan's table", () => {
    expect(amountDuePence({ sharePence: 750, gamesCovered: 5, creditsApplied: 0 })).toBe(3750);
    expect(amountDuePence({ sharePence: 750, gamesCovered: 5, creditsApplied: 1 })).toBe(3000);
    expect(amountDuePence({ sharePence: 750, gamesCovered: 5, creditsApplied: 2 })).toBe(2250);
    expect(amountDuePence({ sharePence: 500, gamesCovered: 5, creditsApplied: 0 })).toBe(2500);
    expect(amountDuePence({ sharePence: 750, gamesCovered: 3, creditsApplied: 0 })).toBe(2250);
  });

  it("is unknown while no share is set, and never negative", () => {
    expect(amountDuePence({ sharePence: null, gamesCovered: 4, creditsApplied: 0 })).toBeNull();
    expect(amountDuePence({ sharePence: 750, gamesCovered: 2, creditsApplied: 5 })).toBe(0);
  });
});

const NOW = new Date("2026-10-06T09:00:00Z");
const MEMBERS = new Set(["u-alex", "u-bilal", "u-carl", "u-omar", "u-sam"]);

function seed(over: Partial<MonthSeedInput> = {}): MonthSeedInput {
  return {
    activityId: "act-mnf",
    gamesScheduled: 4,
    gamesPlayed: 1,
    sharePerGamePence: 750,
    source: "seed-tick",
    rows: [
      { userId: "u-alex", kind: "regular", paid: "confirmed", paidAmountPence: 3000 },
      { userId: "u-bilal", kind: "regular", paid: "claimed", paidAmountPence: 2250, creditsCarriedIn: 1 },
      { userId: "u-carl", kind: "regular" },
      { userId: "u-omar", kind: "payg" },
    ],
    ...over,
  };
}

const CTX = { memberUserIds: MEMBERS, actorUserId: "u-sam", now: NOW };

describe("planMonthSeed: starting a month part-way through", () => {
  it("the month is running at once, with the played games counted", () => {
    const r = planMonthSeed(seed(), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.month).toEqual({
      activityId: "act-mnf",
      status: "running",
      gamesScheduled: 4,
      gamesPlayedBeforeStart: 1,
      sharePerGamePence: 750,
      concessionPerGamePence: null,
      startedMidMonthAt: NOW,
      startedByUserId: "u-sam",
    });
  });

  it("a regular covers the whole month: games already played count as played", () => {
    const r = planMonthSeed(seed(), CTX);
    if (!r.ok) throw new Error(r.error);
    const carl = r.members.find((m) => m.userId === "u-carl")!;
    expect(carl).toMatchObject({
      kind: "regular",
      tier: "standard",
      slot: 3,
      gamesCovered: 4,
      creditsApplied: 0,
      amountDuePence: 3000,
      paidAt: null,
      paidClaimedAt: null,
      source: "seed-tick",
    });
  });

  it("confirmed paid is recorded as confirmed by the organiser who started the month", () => {
    const r = planMonthSeed(seed(), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.members.find((m) => m.userId === "u-alex")).toMatchObject({
      paidAt: NOW,
      paidAmountPence: 3000,
      paidConfirmedByUserId: "u-sam",
      paidClaimedAt: null,
    });
  });

  it("'says paid' is a claim and never sets paidAt", () => {
    const r = planMonthSeed(seed(), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.members.find((m) => m.userId === "u-bilal")).toMatchObject({
      paidAt: null,
      paidAmountPence: null,
      paidConfirmedByUserId: null,
      paidClaimedAt: NOW,
      paidClaimedAmountPence: 2250,
      paidClaimSource: "organiser",
    });
  });

  it("a claim read from a pasted list is sourced to the list", () => {
    const r = planMonthSeed(seed({ source: "seed-list" }), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.members.find((m) => m.userId === "u-bilal")).toMatchObject({ paidClaimSource: "list", source: "seed-list" });
  });

  it("confirmed with no amount typed records the amount due", () => {
    const r = planMonthSeed(seed({ rows: [{ userId: "u-alex", kind: "regular", paid: "confirmed" }] }), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.members[0]).toMatchObject({ paidAmountPence: 3000 });
  });

  it("credits carried in are applied to this month and written to the ledger, one row a game", () => {
    const r = planMonthSeed(seed(), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.members.find((m) => m.userId === "u-bilal")).toMatchObject({ creditsApplied: 1, amountDuePence: 2250 });
    expect(r.credits).toEqual([
      { userId: "u-bilal", games: 1, reason: "carried-in", appliedAt: NOW, createdById: "u-sam" },
    ]);
  });

  it("a PAYG player owes nothing for the month and carries no payment or credit", () => {
    const r = planMonthSeed(
      seed({ rows: [{ userId: "u-omar", kind: "payg", paid: "confirmed", paidAmountPence: 800, creditsCarriedIn: 2 }] }),
      CTX,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.members[0]).toMatchObject({
      kind: "payg",
      gamesCovered: 0,
      creditsApplied: 0,
      amountDuePence: null,
      paidAt: null,
      paidClaimedAt: null,
    });
    expect(r.credits).toEqual([]);
  });

  it("slots: regulars in the order given, then PAYG players", () => {
    const r = planMonthSeed(
      seed({
        rows: [
          { userId: "u-omar", kind: "payg" },
          { userId: "u-alex", kind: "regular" },
          { userId: "u-carl", kind: "regular" },
        ],
      }),
      CTX,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.members.map((m) => [m.userId, m.slot])).toEqual([
      ["u-alex", 1],
      ["u-carl", 2],
      ["u-omar", 3],
    ]);
  });

  it("slot numbers written on a list are kept; the rest take the lowest free number", () => {
    const r = planMonthSeed(
      seed({
        rows: [
          { userId: "u-alex", kind: "regular", slot: 2 },
          { userId: "u-omar", kind: "payg", slot: 6 },
          { userId: "u-carl", kind: "regular" },
          { userId: "u-bilal", kind: "regular" },
        ],
      }),
      CTX,
    );
    if (!r.ok) throw new Error(r.error);
    expect(Object.fromEntries(r.members.map((m) => [m.userId, m.slot]))).toEqual({
      "u-alex": 2,
      "u-omar": 6,
      "u-carl": 1,
      "u-bilal": 3,
    });
  });

  it("a concession regular uses the concession share, and is unpriced without one", () => {
    const withShare = planMonthSeed(
      seed({ concessionPerGamePence: 500, rows: [{ userId: "u-carl", kind: "regular", tier: "concession" }] }),
      CTX,
    );
    if (!withShare.ok) throw new Error(withShare.error);
    expect(withShare.members[0]).toMatchObject({ tier: "concession", amountDuePence: 2000 });
    const without = planMonthSeed(seed({ rows: [{ userId: "u-carl", kind: "regular", tier: "concession" }] }), CTX);
    if (!without.ok) throw new Error(without.error);
    expect(without.members[0].amountDuePence).toBeNull();
  });

  it("no share yet: amounts stay unknown, payments are still recorded", () => {
    const r = planMonthSeed(seed({ sharePerGamePence: null }), CTX);
    if (!r.ok) throw new Error(r.error);
    expect(r.month.sharePerGamePence).toBeNull();
    expect(r.members.find((m) => m.userId === "u-carl")!.amountDuePence).toBeNull();
    expect(r.members.find((m) => m.userId === "u-alex")!.paidAmountPence).toBe(3000);
  });

  it.each([
    [{ rows: [] }, "no-players"],
    [{ gamesScheduled: 0 }, "bad-games"],
    [{ gamesScheduled: 11 }, "bad-games"],
    [{ gamesPlayed: 5 }, "bad-games"],
    [{ gamesPlayed: -1 }, "bad-games"],
    [{ sharePerGamePence: 0 }, "bad-share"],
    [{ sharePerGamePence: 7.5 }, "bad-share"],
    [{ concessionPerGamePence: -1 }, "bad-share"],
    [{ activityId: "" }, "bad-fixture"],
    [{ rows: [{ userId: "u-alex", kind: "regular" }, { userId: "u-alex", kind: "payg" }] }, "duplicate-player"],
    [{ rows: [{ userId: "u-stranger", kind: "regular" }] }, "not-a-member"],
    [{ rows: [{ userId: "u-alex", kind: "guest" }] }, "bad-row"],
    [{ rows: [{ userId: "u-alex", kind: "regular", tier: "vip" }] }, "bad-row"],
    [{ rows: [{ userId: "u-alex", kind: "regular", paid: "maybe" }] }, "bad-row"],
    [{ rows: [{ userId: "u-alex", kind: "regular", creditsCarriedIn: 5 }] }, "bad-credits"],
    [{ rows: [{ userId: "u-alex", kind: "regular", creditsCarriedIn: 0.5 }] }, "bad-credits"],
    [{ rows: [{ userId: "u-alex", kind: "regular", paid: "confirmed", paidAmountPence: -1 }] }, "bad-amount"],
    [
      { rows: [{ userId: "u-alex", kind: "regular", slot: 2 }, { userId: "u-carl", kind: "regular", slot: 2 }] },
      "duplicate-slot",
    ],
    [{ rows: [{ userId: "u-alex", kind: "regular", slot: 0 }] }, "bad-row"],
  ])("refuses %j with %s", (over, error) => {
    const r = planMonthSeed(seed(over as never), CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });
});

describe("draftSeedFromList: the slice 1 reader's output becomes a draft the organiser checks", () => {
  const ROSTER = [
    { userId: "u-alex", name: "Alex Carter" },
    { userId: "u-bilal", name: "Bilal Khan" },
    { userId: "u-carl", name: "Carl Reyes" },
    { userId: "u-omar", name: "Omar One" },
    { userId: "u-omar2", name: "Omar Two" },
    { userId: "u-sam", name: "Sam Hill", aliases: ["Sammy"] },
    { userId: "u-dev", name: "Dev😁 Patel" },
  ];
  const mark = (m: Partial<NonNullable<SeedListInput["slots"][number]["marks"]>> = {}) => ({
    paid: false,
    paidAmountPence: null,
    tier: null,
    payg: false,
    paygDates: [],
    ...m,
  });

  const LIST: SeedListInput = {
    month: { month: 10 },
    slots: [
      { slot: 1, name: "Alex", marks: mark({ paid: true, paidAmountPence: 3000 }) },
      { slot: 2, name: "bilal khan", marks: mark({ paid: true }) },
      { slot: 3, name: "Carl", marks: mark({ tier: "concession" }) },
      { slot: 4, name: "", marks: mark() },
      { slot: 5, name: "Omar", marks: mark({ payg: true }) },
      { slot: 6, name: "Dev", marks: mark() },
      { slot: 7, name: "Zed", marks: mark() },
    ],
    sections: { cantPlay: [{ slot: 1, name: "Sammy", marks: mark({ paid: true, paidAmountPence: 2250 }) }], reserves: [] },
  };

  it("matches names to the club's players and keeps slot numbers as written", () => {
    const d = draftSeedFromList(LIST, ROSTER, { month: 10 });
    expect(d.rows).toEqual([
      { userId: "u-alex", name: "Alex Carter", kind: "regular", tier: "standard", slot: 1, paid: "claimed", paidAmountPence: 3000 },
      { userId: "u-bilal", name: "Bilal Khan", kind: "regular", tier: "standard", slot: 2, paid: "claimed", paidAmountPence: null },
      { userId: "u-carl", name: "Carl Reyes", kind: "regular", tier: "concession", slot: 3, paid: "none", paidAmountPence: null },
      { userId: "u-dev", name: "Dev😁 Patel", kind: "regular", tier: "standard", slot: 6, paid: "none", paidAmountPence: null },
      // "Paid but can't play" is a paid regular with no slot of their own this week.
      { userId: "u-sam", name: "Sam Hill", kind: "regular", tier: "standard", slot: null, paid: "claimed", paidAmountPence: 2250 },
    ]);
  });

  it("a paid mark on a list is only ever 'says paid'", () => {
    const d = draftSeedFromList(LIST, ROSTER, { month: 10 });
    expect(d.rows.some((r) => r.paid === "confirmed")).toBe(false);
  });

  it("a name that fits nobody, or more than one player, is left for the organiser", () => {
    const d = draftSeedFromList(LIST, ROSTER, { month: 10 });
    expect(d.unmatched).toEqual([
      { slot: 5, name: "Omar", kind: "payg", reason: "ambiguous", candidates: ["u-omar", "u-omar2"] },
      { slot: 7, name: "Zed", kind: "regular", reason: "unknown", candidates: [] },
    ]);
  });

  it("blank slots are skipped, and the same player is never drafted twice", () => {
    const d = draftSeedFromList(
      { slots: [{ slot: 1, name: "Alex" }, { slot: 2, name: " " }, { slot: 3, name: "Alex Carter" }] },
      ROSTER,
      { month: 10 },
    );
    expect(d.rows.map((r) => r.userId)).toEqual(["u-alex"]);
    expect(d.unmatched).toEqual([]);
  });

  it("a number written twice is kept for the first line only", () => {
    const d = draftSeedFromList(
      { slots: [{ slot: 3, name: "Alex" }, { slot: 3, name: "Carl" }] },
      ROSTER,
      { month: 10 },
    );
    expect(d.rows.map((r) => [r.userId, r.slot])).toEqual([
      ["u-alex", 3],
      ["u-carl", null],
    ]);
  });

  it("takes the slice 1 reader's own output, as it is", () => {
    const parsed = parseMonthlyList(
      "List for October:\n\n1. Alex (Paid £30)\n2. Bilal paid\n3. Carl (OAP)\n4.\n5. Omar (PAYG)\n6. Dev😁\n\nPaid but can't play\n1. Sammy",
    );
    if (!parsed) throw new Error("the reader did not read the list");
    // The reader's result is assignable to the seed's input type: no adapter.
    const input: SeedListInput = parsed;
    const d = draftSeedFromList(input, ROSTER, { month: 10 });
    expect(d.monthMismatch).toBe(false);
    expect(d.rows.map((r) => [r.userId, r.kind, r.tier, r.slot, r.paid, r.paidAmountPence])).toEqual([
      ["u-alex", "regular", "standard", 1, "claimed", 3000],
      ["u-bilal", "regular", "standard", 2, "claimed", null],
      ["u-carl", "regular", "concession", 3, "none", null],
      ["u-dev", "regular", "standard", 6, "none", null],
      ["u-sam", "regular", "standard", null, "claimed", null],
    ]);
    expect(d.unmatched.map((u) => [u.name, u.reason])).toEqual([["Omar", "ambiguous"]]);
  });

  it("says so when the list is headed with a different month", () => {
    expect(draftSeedFromList(LIST, ROSTER, { month: 10 }).monthMismatch).toBe(false);
    expect(draftSeedFromList(LIST, ROSTER, { month: 11 }).monthMismatch).toBe(true);
    expect(draftSeedFromList({ slots: [] }, ROSTER, { month: 11 }).monthMismatch).toBe(false);
  });

  it("the draft feeds planMonthSeed unchanged", () => {
    const d = draftSeedFromList(LIST, ROSTER, { month: 10 });
    const r = planMonthSeed(
      { activityId: "act-mnf", gamesScheduled: 4, gamesPlayed: 1, sharePerGamePence: 750, source: "seed-list", rows: d.rows },
      { memberUserIds: new Set(ROSTER.map((m) => m.userId)), actorUserId: "u-sam", now: NOW },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.members.map((m) => [m.userId, m.slot])).toEqual([
      ["u-alex", 1],
      ["u-bilal", 2],
      ["u-carl", 3],
      ["u-dev", 6],
      ["u-sam", 4],
    ]);
    expect(r.members.every((m) => m.paidAt === null)).toBe(true);
  });
});
