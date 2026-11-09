/**
 * Monthly squad, slice 5: the weekly flow's pure rules
 * (MDs/monthly-squad-plan-2026-10-05.md, sections 5 and 6.2).
 * No database, no clock, no model. Made-up names throughout.
 */
import { describe, it, expect } from "vitest";
import { parseMonthlyList } from "@/lib/__tests__/fixtures/monthly-legacy";
import type { MonthlyList, MonthlyListEntry } from "../monthly-list";
import {
  FEE_REPLY_WINDOW_MS,
  LIST_REPOST_FLOOR_MS,
  buildWeekList,
  decideListPost,
  decideMissedCredits,
  decideMonthlySeed,
  decideSlotFor,
  matchMorningMessageSent,
  mayStagePaygFeeOnReply,
  pasteShowsSameList,
  paygPoolOfferAllowed,
  planOpenPlaceOffers,
  reconcileMonthPaste,
  selectPaygPool,
  weekListHash,
  type WeekMember,
  type WeekRow,
} from "../monthly-week-rules";

const reg = (n: number, name: string, over: Partial<WeekMember> = {}): WeekMember => ({
  userId: `u-${name.toLowerCase()}`,
  name,
  kind: "regular",
  slot: n,
  paid: "claimed",
  absent: false,
  paygDated: false,
  left: false,
  ...over,
});
const payg = (name: string, over: Partial<WeekMember> = {}): WeekMember => ({
  userId: `u-${name.toLowerCase()}`,
  name,
  kind: "payg",
  slot: null,
  paid: "none",
  absent: false,
  paygDated: false,
  left: false,
  ...over,
});
const row = (name: string, status: WeekRow["status"], position: number): WeekRow => ({
  userId: `u-${name.toLowerCase()}`,
  name,
  status,
  position,
});

const MEMBERS = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris", { paid: "none" }), reg(4, "Dave", { paid: "confirmed" })];

describe("decideMonthlySeed", () => {
  it("puts every regular in at their slot number, with the monthly marker", () => {
    const d = decideMonthlySeed({ members: MEMBERS, targetRows: [], maxPlayers: 6 });
    expect(d.write).toEqual([
      { userId: "u-alex", status: "CONFIRMED", position: 1, monthly: true, note: "regular of the month" },
      { userId: "u-bilal", status: "CONFIRMED", position: 2, monthly: true, note: "regular of the month" },
      { userId: "u-chris", status: "CONFIRMED", position: 3, monthly: true, note: "regular of the month" },
      { userId: "u-dave", status: "CONFIRMED", position: 4, monthly: true, note: "regular of the month" },
    ]);
    expect(d.markMonthly).toEqual([]);
    expect(d.promote).toEqual([]);
    expect(d.bump).toEqual([]);
  });

  it("a dated PAYG player is in for their date only, and pays per game", () => {
    const members = [...MEMBERS, payg("Omar", { paygDated: true }), payg("Will")];
    const d = decideMonthlySeed({ members, targetRows: [], maxPlayers: 6 });
    expect(d.write.find((w) => w.userId === "u-omar")).toEqual({
      userId: "u-omar",
      status: "CONFIRMED",
      position: 5,
      monthly: false,
      note: "PAYG for this date",
    });
    expect(d.write.some((w) => w.userId === "u-will")).toBe(false);
  });

  it("an away week is written as OUT, at the regular's own slot", () => {
    const members = [reg(1, "Alex"), reg(2, "Bilal", { absent: true })];
    const d = decideMonthlySeed({ members, targetRows: [], maxPlayers: 6 });
    expect(d.write[1]).toEqual({ userId: "u-bilal", status: "DROPPED", position: 2, monthly: true, note: "away this week" });
  });

  it("an early OUT wins: a player who already has a row is never touched, only marked", () => {
    const d = decideMonthlySeed({
      members: MEMBERS,
      targetRows: [
        { userId: "u-bilal", status: "DROPPED" },
        { userId: "u-zed", status: "CONFIRMED" },
      ],
      maxPlayers: 6,
    });
    expect(d.write.map((w) => w.userId)).toEqual(["u-alex", "u-chris", "u-dave"]);
    expect(d.markMonthly).toEqual(["u-bilal"]);
  });

  it("regulars beyond the places go to the waiting list, in slot order", () => {
    const d = decideMonthlySeed({ members: MEMBERS, targetRows: [], maxPlayers: 3 });
    expect(d.write.map((w) => [w.userId, w.status])).toEqual([
      ["u-alex", "CONFIRMED"],
      ["u-bilal", "CONFIRMED"],
      ["u-chris", "CONFIRMED"],
      ["u-dave", "BENCH"],
    ]);
  });

  it("regulars have priority: a non-regular who said IN early gives the place up, last in first", () => {
    const d = decideMonthlySeed({
      members: MEMBERS,
      targetRows: [
        { userId: "u-zed", status: "CONFIRMED", position: 1 },
        { userId: "u-yan", status: "CONFIRMED", position: 2 },
      ],
      maxPlayers: 5,
    });
    // Four regulars and five places: one of the two early INs stays.
    expect(d.write.map((w) => [w.userId, w.status])).toEqual([
      ["u-alex", "CONFIRMED"],
      ["u-bilal", "CONFIRMED"],
      ["u-chris", "CONFIRMED"],
      ["u-dave", "CONFIRMED"],
    ]);
    expect(d.bump).toEqual(["u-yan"]);
  });

  it("nobody is moved while there is room for everyone", () => {
    const d = decideMonthlySeed({ members: MEMBERS, targetRows: [{ userId: "u-zed", status: "CONFIRMED", position: 1 }], maxPlayers: 5 });
    expect(d.bump).toEqual([]);
  });

  it("a regular who was put on the waiting list before the seed is brought in, ahead of a non-regular", () => {
    const d = decideMonthlySeed({
      members: MEMBERS,
      targetRows: [
        { userId: "u-zed", status: "CONFIRMED", position: 1 },
        { userId: "u-alex", status: "BENCH", position: 2 },
      ],
      maxPlayers: 4,
    });
    expect(d.promote).toEqual(["u-alex"]);
    expect(d.bump).toEqual(["u-zed"]);
    expect(d.write.map((w) => [w.userId, w.status])).toEqual([
      ["u-bilal", "CONFIRMED"],
      ["u-chris", "CONFIRMED"],
      ["u-dave", "CONFIRMED"],
    ]);
    expect(d.markMonthly).toEqual(["u-alex"]);
  });

  it("seeding twice writes nothing the second time", () => {
    const first = decideMonthlySeed({ members: MEMBERS, targetRows: [], maxPlayers: 6 });
    const second = decideMonthlySeed({
      members: MEMBERS,
      targetRows: first.write.map((w) => ({ userId: w.userId, status: w.status })),
      maxPlayers: 6,
    });
    expect(second.write).toEqual([]);
  });
});

describe("buildWeekList", () => {
  const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "DROPPED", 2), row("Chris", "CONFIRMED", 3), row("Dave", "CONFIRMED", 4)];

  it("keeps slot numbers, shows paid as claimed, and moves a regular who is out to 'Paid but can't play'", () => {
    const list = buildWeekList({ members: MEMBERS, rows, maxPlayers: 6 });
    expect(list.slots).toEqual([
      { slot: 1, userId: "u-alex", name: "Alex", mark: "paid" },
      { slot: 2, userId: null, name: "", mark: null },
      { slot: 3, userId: "u-chris", name: "Chris", mark: null },
      { slot: 4, userId: "u-dave", name: "Dave", mark: "paid" },
      { slot: 5, userId: null, name: "", mark: null },
      { slot: 6, userId: null, name: "", mark: null },
    ]);
    expect(list.paidCantPlay).toEqual([{ userId: "u-bilal", name: "Bilal" }]);
    expect(list.cantPlay).toEqual([]);
    expect(list.open).toBe(3);
  });

  it("a regular who has not paid and is out is listed apart, never as paid", () => {
    const list = buildWeekList({
      members: MEMBERS,
      rows: [row("Alex", "CONFIRMED", 1), row("Chris", "DROPPED", 3)],
      maxPlayers: 6,
    });
    expect(list.paidCantPlay).toEqual([]);
    expect(list.cantPlay).toEqual([{ userId: "u-chris", name: "Chris" }]);
  });

  it("a fill-in sits in the slot it took and is marked PAYG", () => {
    const list = buildWeekList({ members: MEMBERS, rows: [...rows, row("Omar", "CONFIRMED", 2)], maxPlayers: 6 });
    expect(list.slots[1]).toEqual({ slot: 2, userId: "u-omar", name: "Omar", mark: "payg" });
    expect(list.open).toBe(2);
  });

  it("a fill-in whose position is no free slot takes the lowest free one", () => {
    const list = buildWeekList({ members: MEMBERS, rows: [...rows, row("Omar", "CONFIRMED", 9)], maxPlayers: 6 });
    expect(list.slots[1].userId).toBe("u-omar");
  });

  it("the waiting list is shown under Reserves", () => {
    const list = buildWeekList({ members: MEMBERS, rows: [...rows, row("Zed", "BENCH", 7)], maxPlayers: 6 });
    expect(list.reserves).toEqual([{ userId: "u-zed", name: "Zed" }]);
  });

  it("an away week with no row yet is listed as can't play", () => {
    const members = [reg(1, "Alex"), reg(2, "Bilal", { absent: true })];
    const list = buildWeekList({ members, rows: [row("Alex", "CONFIRMED", 1)], maxPlayers: 4 });
    expect(list.paidCantPlay).toEqual([{ userId: "u-bilal", name: "Bilal" }]);
  });
});

describe("decideSlotFor (the fill-in takes the vacated number)", () => {
  const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "DROPPED", 2), row("Chris", "CONFIRMED", 3), row("Dave", "CONFIRMED", 4)];

  it("a PAYG player takes the lowest vacated slot, not the next number", () => {
    const after = [...rows, row("Omar", "CONFIRMED", 5)];
    expect(decideSlotFor({ members: MEMBERS, rows: after, maxPlayers: 6, userId: "u-omar" })).toEqual({
      slot: 2,
      vacatedByUserId: "u-bilal",
    });
  });

  it("a regular who comes back takes their own slot while it is free", () => {
    const after = [row("Alex", "CONFIRMED", 1), row("Bilal", "CONFIRMED", 9), row("Chris", "CONFIRMED", 3)];
    expect(decideSlotFor({ members: MEMBERS, rows: after, maxPlayers: 6, userId: "u-bilal" })).toEqual({
      slot: 2,
      vacatedByUserId: null,
    });
  });

  it("a regular whose slot was taken gets the lowest free one", () => {
    const after = [row("Alex", "CONFIRMED", 1), row("Omar", "CONFIRMED", 2), row("Bilal", "CONFIRMED", 9), row("Chris", "CONFIRMED", 3), row("Dave", "CONFIRMED", 4)];
    expect(decideSlotFor({ members: MEMBERS, rows: after, maxPlayers: 6, userId: "u-bilal" })?.slot).toBe(5);
  });

  it("a slot kept for a regular with no row yet is not given away", () => {
    const after = [row("Alex", "CONFIRMED", 1), row("Omar", "CONFIRMED", 1)];
    expect(decideSlotFor({ members: MEMBERS, rows: after, maxPlayers: 6, userId: "u-omar" })?.slot).toBe(5);
  });

  it("null for somebody who is not playing", () => {
    expect(decideSlotFor({ members: MEMBERS, rows, maxPlayers: 6, userId: "u-bilal" })).toBeNull();
  });
});

describe("decideMissedCredits", () => {
  const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "DROPPED", 2), row("Chris", "DROPPED", 3), row("Dave", "CONFIRMED", 4)];
  const base = { members: MEMBERS, rows, maxPlayers: 6, existing: [] };

  it("any-miss: a paid (or says-paid) regular who is out earns one game; an unpaid one does not", () => {
    expect(decideMissedCredits({ ...base, rule: "any-miss" })).toEqual({ create: ["u-bilal"], voidIds: [], releaseElsewhere: [] });
  });

  it("filled-only: only once somebody has taken the place", () => {
    expect(decideMissedCredits({ ...base, rule: "filled-only" })).toEqual({ create: [], voidIds: [], releaseElsewhere: [] });
    const filled = [...rows, row("Omar", "CONFIRMED", 2)];
    expect(decideMissedCredits({ ...base, rows: filled, rule: "filled-only" })).toEqual({ create: ["u-bilal"], voidIds: [], releaseElsewhere: [] });
  });

  it("none: never", () => {
    expect(decideMissedCredits({ ...base, rule: "none" })).toEqual({ create: [], voidIds: [], releaseElsewhere: [] });
  });

  it("is idempotent: a credit that exists is not written again", () => {
    const existing = [{ id: "c1", userId: "u-bilal", voidedAt: null, voidedById: null, appliedMonthId: null, createdById: null }];
    expect(decideMissedCredits({ ...base, rule: "any-miss", existing })).toEqual({ create: [], voidIds: [], releaseElsewhere: [] });
  });

  it("a regular who comes back loses the credit MatchTime wrote, unless it was already used", () => {
    const back = [row("Alex", "CONFIRMED", 1), row("Bilal", "CONFIRMED", 2)];
    const mk = (over: Record<string, unknown>) => [
      { id: "c1", userId: "u-bilal", voidedAt: null, voidedById: null, appliedMonthId: null, createdById: null, ...over },
    ];
    expect(decideMissedCredits({ ...base, rows: back, rule: "any-miss", existing: mk({}) }).voidIds).toEqual(["c1"]);
    expect(decideMissedCredits({ ...base, rows: back, rule: "any-miss", existing: mk({ appliedMonthId: "m2" }) }).voidIds).toEqual([]);
    expect(decideMissedCredits({ ...base, rows: back, rule: "any-miss", existing: mk({ createdById: "u-admin" }) }).voidIds).toEqual([]);
  });

  it("a credit an admin voided is never written again", () => {
    const existing = [{ id: "c1", userId: "u-bilal", voidedAt: new Date(), voidedById: "u-admin", appliedMonthId: null, createdById: null }];
    expect(decideMissedCredits({ ...base, rule: "any-miss", existing })).toEqual({ create: [], voidIds: [], releaseElsewhere: [] });
  });

  it("a paid regular left on the waiting list misses the game through no choice of their own: credited", () => {
    const benched = [row("Alex", "CONFIRMED", 1), row("Bilal", "BENCH", 2), row("Omar", "CONFIRMED", 3)];
    for (const rule of ["any-miss", "filled-only"] as const) {
      expect(decideMissedCredits({ ...base, rows: benched, rule }).create).toEqual(["u-bilal"]);
    }
    expect(decideMissedCredits({ ...base, rows: benched, rule: "none" }).create).toEqual([]);
  });

  it("a regular who drops, comes back and is benched behind the fill-in keeps the credit", () => {
    const existing = [{ id: "c1", userId: "u-bilal", voidedAt: null, voidedById: null, appliedMonthId: null, createdById: null }];
    const benched = [row("Alex", "CONFIRMED", 1), row("Bilal", "BENCH", 9), row("Omar", "CONFIRMED", 2)];
    expect(decideMissedCredits({ ...base, rows: benched, rule: "any-miss", existing })).toEqual({ create: [], voidIds: [], releaseElsewhere: [] });
  });

  it("filled-only with two out and one fill-in: the place of whoever dropped FIRST is the one filled", () => {
    const at = (iso: string) => new Date(iso);
    const members = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris"), reg(4, "Dave")];
    const two = [
      row("Alex", "CONFIRMED", 1),
      // Chris (slot 3) dropped before Bilal (slot 2).
      { ...row("Bilal", "DROPPED", 2), outAt: at("2026-10-08T12:00:00Z") },
      { ...row("Chris", "DROPPED", 3), outAt: at("2026-10-08T09:00:00Z") },
      row("Dave", "CONFIRMED", 4),
      row("Omar", "CONFIRMED", 2),
    ];
    expect(decideMissedCredits({ ...base, members, rows: two, rule: "filled-only" }).create).toEqual(["u-chris"]);
    // A second fill-in fills the other.
    expect(decideMissedCredits({ ...base, members, rows: [...two, row("Will", "CONFIRMED", 3)], rule: "filled-only" }).create).toEqual([
      "u-bilal",
      "u-chris",
    ]);
    // Same moment: the lower slot number, then the user id.
    const tie = two.map((r) => ("outAt" in r ? { ...r, outAt: at("2026-10-08T09:00:00Z") } : r));
    expect(decideMissedCredits({ ...base, members, rows: tie, rule: "filled-only" }).create).toEqual(["u-bilal"]);
  });

  it("a PAYG player who drops earns nothing", () => {
    const members = [...MEMBERS, payg("Omar")];
    const r = [...rows, row("Omar", "DROPPED", 5)];
    expect(decideMissedCredits({ ...base, members, rows: r, rule: "any-miss" }).create).toEqual(["u-bilal"]);
  });
});

describe("the PAYG pool", () => {
  const cands = [
    { userId: "a", name: "Ann", phoneNumber: "+447700900101", inviteDm: true, leftAt: null, isActive: true },
    { userId: "b", name: "Bob", phoneNumber: "+447700900102", inviteDm: false, leftAt: null, isActive: true },
    { userId: "c", name: "Cat", phoneNumber: "+447700900103", inviteDm: true, leftAt: new Date(), isActive: true },
    { userId: "d", name: "Dan", phoneNumber: "+447700900104", inviteDm: true, leftAt: null, isActive: true },
    { userId: "e", name: "Eve", phoneNumber: null, inviteDm: true, leftAt: null, isActive: true },
    { userId: "f", name: "Fay", phoneNumber: "+447700900106", inviteDm: true, leftAt: null, isActive: false },
    { userId: "g", name: "Gus", phoneNumber: "+447700900107", inviteDm: true, leftAt: null, isActive: true },
  ];

  it("leaves out opted-out players, leavers, anyone on the match, regulars, and anyone who cannot be DMed", () => {
    const pool = selectPaygPool({ candidates: cands, onMatchUserIds: ["d"], regularUserIds: ["g"] });
    expect(pool.map((p) => p.userId)).toEqual(["a"]);
  });

  it("is offered only on a first-come club with nobody waiting and somebody to ask", () => {
    expect(paygPoolOfferAllowed({ pickMode: "first-come", benchCount: 0, poolSize: 2 })).toBe(true);
    expect(paygPoolOfferAllowed({ pickMode: "organiser", benchCount: 0, poolSize: 2 })).toBe(false);
    expect(paygPoolOfferAllowed({ pickMode: "first-come", benchCount: 1, poolSize: 2 })).toBe(false);
    expect(paygPoolOfferAllowed({ pickMode: "first-come", benchCount: 0, poolSize: 0 })).toBe(false);
  });
});

describe("decideListPost", () => {
  const MATCH = new Date("2026-10-12T19:00:00.000Z"); // Mon 12 Oct, 20:00 London
  const base = {
    matchDate: MATCH,
    hash: "h2",
    lastShownHash: "h1" as string | null,
    lastPostAt: null as Date | null,
    live: true,
    nextUpcoming: true,
    teamsOut: false,
  };
  const at = (iso: string) => new Date(iso);

  it("posts when the list changed", () => {
    expect(decideListPost({ ...base, now: at("2026-10-08T10:00:00.000Z") })).toBe("change");
  });

  it("posts the first time (nothing shown yet)", () => {
    expect(decideListPost({ ...base, lastShownHash: null, now: at("2026-10-08T10:00:00.000Z") })).toBe("change");
  });

  it("stays quiet when the group has already seen this list", () => {
    expect(decideListPost({ ...base, lastShownHash: "h2", now: at("2026-10-08T10:00:00.000Z") })).toBeNull();
  });

  it("never more than once every 30 minutes", () => {
    const now = at("2026-10-08T10:00:00.000Z");
    expect(decideListPost({ ...base, now, lastPostAt: new Date(now.getTime() - LIST_REPOST_FLOOR_MS + 1000) })).toBeNull();
    expect(decideListPost({ ...base, now, lastPostAt: new Date(now.getTime() - LIST_REPOST_FLOOR_MS) })).toBe("change");
  });

  it("never between 23:00 and 08:59 London", () => {
    expect(decideListPost({ ...base, now: at("2026-10-08T21:00:00.000Z") })).toBe("change"); // 22:00 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T21:59:00.000Z") })).toBe("change"); // 22:59 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T22:00:00.000Z") })).toBeNull(); // 23:00 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T06:59:00.000Z") })).toBeNull(); // 07:59 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T07:00:00.000Z") })).toBeNull(); // 08:00 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T07:59:00.000Z") })).toBeNull(); // 08:59 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T08:00:00.000Z") })).toBe("change"); // 09:00 BST
  });

  it("once on match morning, even with nothing changed (when no morning message went out yet)", () => {
    const same = { ...base, lastShownHash: "h2", lastPostAt: at("2026-10-09T10:00:00.000Z") };
    expect(decideListPost({ ...same, now: at("2026-10-12T07:30:00.000Z") })).toBeNull(); // 08:30 BST: not yet
    expect(decideListPost({ ...same, now: at("2026-10-12T08:00:00.000Z") })).toBe("morning"); // 09:00 BST
    expect(decideListPost({ ...same, now: at("2026-10-12T08:30:00.000Z") })).toBe("morning"); // 09:30 BST
    expect(decideListPost({ ...same, now: at("2026-10-12T12:30:00.000Z") })).toBeNull(); // afternoon
    // already posted this morning
    expect(decideListPost({ ...same, lastPostAt: at("2026-10-12T08:10:00.000Z"), now: at("2026-10-12T09:30:00.000Z") })).toBeNull();
  });

  it("match morning: not when the group saw this same list in the last three hours (2026-10-06)", () => {
    // Somebody asked "who's in?" at 08:30 and got the list. At 09:00 the
    // same list is not posted again. The rule PR #204 gave the weekly
    // roster: the same squad is not shown twice inside three hours.
    const same = { ...base, lastShownHash: "h2", lastPostAt: at("2026-10-12T07:30:00.000Z") }; // 08:30 BST
    expect(decideListPost({ ...same, now: at("2026-10-12T08:00:00.000Z"), sameListShownRecently: true })).toBeNull(); // 09:00 BST
    // Three hours on it is no longer a repeat: the morning post goes out.
    expect(decideListPost({ ...same, now: at("2026-10-12T10:31:00.000Z"), sameListShownRecently: false })).toBe("morning");
    // A list that has CHANGED since is posted whatever was shown before.
    expect(decideListPost({ ...same, hash: "h3", now: at("2026-10-12T08:00:00.000Z"), sameListShownRecently: false })).toBe("change");
  });

  it("match morning: not when the morning chase already went out today (Vets, 9 Nov 2026)", () => {
    // 08:00 London "Still 3 short ... Any takers?", then at 09:00 the same
    // unchanged list: the group already had its morning message.
    const same = { ...base, lastShownHash: "h2", lastPostAt: at("2026-10-11T20:15:00.000Z") }; // 21:15 BST the night before
    expect(decideListPost({ ...same, now: at("2026-10-12T08:00:00.000Z"), morningChaseSent: true })).toBeNull(); // 09:00 BST
    expect(decideListPost({ ...same, now: at("2026-10-12T10:00:00.000Z"), morningChaseSent: true })).toBeNull(); // 11:00 BST
    // Without the chase the morning post goes out as before.
    expect(decideListPost({ ...same, now: at("2026-10-12T08:00:00.000Z"), morningChaseSent: false })).toBe("morning");
    // A list that CHANGED is posted whatever the chase said.
    expect(decideListPost({ ...same, hash: "h3", now: at("2026-10-12T08:00:00.000Z"), morningChaseSent: true })).toBe("change");
  });

  it("not once the teams are out, not for a match that is over, not for next week's match", () => {
    const now = at("2026-10-08T10:00:00.000Z");
    expect(decideListPost({ ...base, now, teamsOut: true })).toBeNull();
    expect(decideListPost({ ...base, now, live: false })).toBeNull();
    expect(decideListPost({ ...base, now, nextUpcoming: false })).toBeNull();
    expect(decideListPost({ ...base, now: at("2026-10-12T19:30:00.000Z") })).toBeNull(); // kicked off
  });

  it("the hash is stable and tells two lists apart", () => {
    expect(weekListHash("a\nb")).toBe(weekListHash("a\nb"));
    expect(weekListHash("a\nb")).not.toBe(weekListHash("a\nc"));
    expect(weekListHash("x")).toMatch(/^[0-9a-f]{8,}$/);
  });
});

describe("matchMorningMessageSent: ONE morning message on match day (Vets, 9 Nov 2026)", () => {
  const MATCH = new Date("2026-11-09T20:30:00.000Z"); // Mon 9 Nov, 20:30 London (GMT)
  const at = (iso: string) => new Date(iso);
  const EARLY = { enabled: true, from: "23:00", to: "07:00" };

  it("the morning chase went out today: the group has had its morning message", () => {
    expect(matchMorningMessageSent({ now: at("2026-11-09T09:00:00.000Z"), matchDate: MATCH, morningChaseSent: true })).toBe(true);
  });

  it("a list shown since the club's day start (09:00 by default) on match day", () => {
    const now = at("2026-11-09T10:00:00.000Z");
    expect(matchMorningMessageSent({ now, matchDate: MATCH, lastListShownAt: at("2026-11-09T09:00:00.000Z") })).toBe(true);
    // 21:15 the night before is not this morning's message.
    expect(matchMorningMessageSent({ now, matchDate: MATCH, lastListShownAt: at("2026-11-08T21:15:00.000Z") })).toBe(false);
    // Nor 08:30, before the day starts.
    expect(matchMorningMessageSent({ now, matchDate: MATCH, lastListShownAt: at("2026-11-09T08:30:00.000Z") })).toBe(false);
  });

  it("a club whose day starts at 07:00: the 07:00 list is the morning message, so the 08:00 chase is not another", () => {
    const now = at("2026-11-09T08:00:00.000Z");
    expect(matchMorningMessageSent({ now, matchDate: MATCH, lastListShownAt: at("2026-11-09T07:00:00.000Z"), quiet: EARLY })).toBe(true);
    expect(matchMorningMessageSent({ now, matchDate: MATCH, lastListShownAt: at("2026-11-09T06:30:00.000Z"), quiet: EARLY })).toBe(false);
  });

  it("nothing sent, or not match day: false", () => {
    expect(matchMorningMessageSent({ now: at("2026-11-09T09:00:00.000Z"), matchDate: MATCH })).toBe(false);
    // The day before, a list at 09:00 and a chase flag are not match-day mornings.
    expect(
      matchMorningMessageSent({ now: at("2026-11-08T10:00:00.000Z"), matchDate: MATCH, lastListShownAt: at("2026-11-08T09:00:00.000Z") }),
    ).toBe(false);
    expect(matchMorningMessageSent({ now: at("2026-11-08T10:00:00.000Z"), matchDate: MATCH, morningChaseSent: true })).toBe(false);
  });
});

describe("reconcileMonthPaste (plan 6.2, a running month)", () => {
  const members = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris", { paid: "none" }), reg(4, "Dave"), payg("Omar")];
  const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "CONFIRMED", 2), row("Chris", "CONFIRMED", 3), row("Dave", "CONFIRMED", 4)];
  const roster = [
    ...members.map((m) => ({ userId: m.userId, name: m.userId === "u-omar" ? "Omar Khan" : m.name, aliases: [] as string[] })),
    { userId: "u-rob", name: "Rob Admin", aliases: [] },
    { userId: "u-tom", name: "Tom Reed", aliases: ["tommo"] },
    { userId: "u-sam1", name: "Sam One", aliases: [] },
    { userId: "u-sam2", name: "Sam Two", aliases: [] },
  ];
  const base = { members, rows, maxPlayers: 6, roster, matchMonth: 10, seeded: true };
  const paste = (text: string) => parseMonthlyList(text)!;
  const LIST = ["List for October:", "1. Alex (paid)", "2. Bilal (paid)", "3. Chris", "4. Dave (paid)", "5.", "6."].join("\n");
  const run = (text: string, senderUserId: string | null, over: Partial<typeof base> & { senderIsAdmin?: boolean } = {}) =>
    reconcileMonthPaste({ ...base, list: paste(text), senderUserId, senderIsAdmin: false, ...over });

  it("a paste that restates the list changes nothing", () => {
    const r = run(LIST, "u-alex");
    expect(r).toMatchObject({ actions: [], ignored: [], notAdded: [], otherMonth: false, notThisList: false });
  });

  it("a member adds their own name: in for this week (any club member may add THEMSELVES)", () => {
    expect(run(LIST.replace("5.", "5. Omar (PAYG)"), "u-omar").actions).toEqual([{ kind: "in", userId: "u-omar", name: "Omar", self: true, slot: 5 }]);
    expect(run(LIST.replace("5.", "5. Tommo"), "u-tom").actions).toEqual([{ kind: "in", userId: "u-tom", name: "Tommo", self: true, slot: 5 }]);
  });

  it("somebody else may add a member of THIS MONTH (a PAYG player of the month)", () => {
    expect(run(LIST.replace("5.", "5. Omar (PAYG)"), "u-alex").actions).toEqual([{ kind: "in", userId: "u-omar", name: "Omar", self: false, slot: 5 }]);
  });

  it("somebody else can NOT add a club player who is not in the month: not registered, reported", () => {
    const r = run(LIST.replace("5.", "5. Tom Reed"), "u-alex");
    expect(r.actions).toEqual([]);
    expect(r.notAdded).toEqual([{ name: "Tom Reed", reason: "not-in-month" }]);
  });

  it("a name nobody has is NEVER registered and never becomes the sender: reported", () => {
    // Sender on the list.
    const a = run(LIST.replace("5.", "5. Tariq"), "u-alex");
    expect(a.actions).toEqual([]);
    expect(a.notAdded).toEqual([{ name: "Tariq", reason: "unknown" }]);
    // Sender NOT on the list and not playing: still not them, and no alias.
    const b = run(LIST.replace("5.", "5. Big O"), "u-omar");
    expect(b.actions).toEqual([]);
    expect(b.notAdded).toEqual([{ name: "Big O", reason: "unknown" }]);
  });

  it("a name that fits two players is never guessed: reported", () => {
    const r = run(LIST.replace("5.", "5. Sam"), "u-alex");
    expect(r.actions).toEqual([]);
    expect(r.notAdded).toEqual([{ name: "Sam", reason: "ambiguous" }]);
  });

  it("with no month header, a list that is not mostly this month's players is not the month's list at all", () => {
    const kit = ["Kit for Monday", "1. Bibs", "2. Two balls", "3. Cones", "4. Pump"].join("\n");
    const r = run(kit, "u-alex");
    expect(r.notThisList).toBe(true);
    expect(r.actions).toEqual([]);
    expect(r.notAdded).toEqual([]);
    // Three of five names are this month's players (60%): it is the list.
    const headerless = ["1. Alex", "2. Bilal", "3. Chris", "4. Bibs", "5. Cones"].join("\n");
    expect(run(headerless, "u-alex").notThisList).toBe(false);
    // Two of five: it is not.
    expect(run(["1. Alex", "2. Bilal", "3. Balls", "4. Bibs", "5. Cones"].join("\n"), "u-alex").notThisList).toBe(true);
    // With the month header it is the list, whatever is on it.
    expect(run(["List for October", "1. Bibs", "2. Cones"].join("\n"), "u-alex").notThisList).toBe(false);
  });

  it("D4: moving somebody else under 'Paid but can't play' is applied, and flagged as not their own doing", () => {
    const text = ["List for October:", "1. Alex (paid)", "2.", "3. Chris", "4. Dave (paid)", "", "Paid but can't play", "1. Bilal"].join("\n");
    expect(run(text, "u-alex").actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: false, via: "cant-play" }]);
    expect(run(text, "u-bilal").actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: true, via: "cant-play" }]);
  });

  it("a blanked line is an OUT only from the player or an admin; from anyone else it is an old copy", () => {
    const text = LIST.replace("2. Bilal (paid)", "2.");
    expect(run(text, "u-bilal").actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: true, via: "blank" }]);
    expect(run(text, "u-rob", { senderIsAdmin: true }).actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: false, via: "blank" }]);
    const other = run(text, "u-alex");
    expect(other.actions).toEqual([]);
    expect(other.ignored).toEqual([{ name: "Bilal", reason: "blank-by-other" }]);
  });

  it("a name simply missing is ignored", () => {
    expect(run(["List for October:", "1. Alex (paid)", "3. Chris", "4. Dave (paid)"].join("\n"), "u-alex").actions).toEqual([]);
  });

  it("a paste never brings back a player who dropped, not even an admin's; only the player's own", () => {
    const dropped = rows.map((r) => (r.userId === "u-bilal" ? { ...r, status: "DROPPED" as const } : r));
    const stale = run(LIST, "u-alex", { rows: dropped });
    expect(stale.actions).toEqual([]);
    expect(stale.ignored).toEqual([{ name: "Bilal", reason: "stale-readd" }]);
    const admin = run(LIST, "u-rob", { rows: dropped, senderIsAdmin: true });
    expect(admin.actions).toEqual([]);
    expect(admin.ignored).toEqual([{ name: "Bilal", reason: "stale-readd" }]);
    expect(run(LIST, "u-bilal", { rows: dropped }).actions).toEqual([{ kind: "in", userId: "u-bilal", name: "Bilal", self: true, slot: 2 }]);
  });

  it("an OLD copy from an admin has no admin powers: it re-adds nobody and blanks nobody out", () => {
    // Bilal has dropped and Omar took slot 2. The admin pastes yesterday's
    // list: Bilal back in 2, and slot 4 (Dave) blank.
    const now = [row("Alex", "CONFIRMED", 1), row("Bilal", "DROPPED", 2), row("Omar", "CONFIRMED", 2), row("Chris", "CONFIRMED", 3), row("Dave", "CONFIRMED", 4)];
    const old = ["List for October:", "1. Alex (paid)", "2. Bilal (paid)", "3. Chris", "4."].join("\n");
    const r = run(old, "u-rob", { rows: now, senderIsAdmin: true });
    expect(r.actions).toEqual([]);
    expect(r.ignored).toEqual([
      { name: "Bilal", reason: "stale-readd" },
      { name: "Dave", reason: "old-copy" },
    ]);
    // And it does not move anybody else under can't play either.
    const old2 = [old, "", "Paid but can't play", "1. Dave"].join("\n");
    expect(run(old2, "u-rob", { rows: now, senderIsAdmin: true }).actions).toEqual([]);
  });

  it("D3: a new paid mark is a claim, whoever wrote it, and a missing mark removes nothing", () => {
    const text = LIST.replace("3. Chris", "3. Chris (Paid £22.50)").replace("1. Alex (paid)", "1. Alex");
    expect(run(text, "u-chris").actions).toEqual([{ kind: "paid-claim", userId: "u-chris", name: "Chris", self: true, amountPence: 2250 }]);
    expect(run(text, "u-alex").actions).toEqual([{ kind: "paid-claim", userId: "u-chris", name: "Chris", self: false, amountPence: 2250 }]);
  });

  it("a paid mark on a PAYG line is not a claim for the month", () => {
    const r2 = [...rows, row("Omar", "CONFIRMED", 5)];
    expect(run(LIST.replace("5.", "5. Omar (PAYG, paid £8)"), "u-omar", { rows: r2 }).actions).toEqual([]);
  });

  it("BEFORE the week is seeded a paste only records paid marks: nobody in, nobody out, nobody away", () => {
    // The week after: no rows yet. The paste lists everyone, moves Dave
    // out, adds Omar and marks Chris paid.
    const text = ["List for October:", "1. Alex (paid)", "2. Bilal (paid)", "3. Chris (paid)", "4.", "5. Omar (PAYG)", "", "Paid but can't play", "1. Dave"].join("\n");
    const r = run(text, "u-rob", { rows: [], seeded: false, senderIsAdmin: true });
    expect(r.actions).toEqual([{ kind: "paid-claim", userId: "u-chris", name: "Chris", self: false, amountPence: null }]);
    expect(r.ignored).toEqual([]);
    expect(r.notAdded).toEqual([]);
  });

  it("a list for another month is not this month's list", () => {
    const r = run(LIST.replace("October", "November").replace("5.", "5. Omar"), "u-omar");
    expect(r.otherMonth).toBe(true);
    expect(r.actions).toEqual([]);
  });

  it("pasteShowsSameList: equal by who is in which slot and who can't play, whatever the marks say", () => {
    const list = buildWeekList({ members, rows, maxPlayers: 6 });
    expect(pasteShowsSameList({ list: paste(LIST), week: list, roster })).toBe(true);
    expect(pasteShowsSameList({ list: paste(LIST.replace("1. Alex (paid)", "1. Alex")), week: list, roster })).toBe(true);
    expect(pasteShowsSameList({ list: paste(LIST.replace("2. Bilal (paid)", "2.")), week: list, roster })).toBe(false);
    expect(pasteShowsSameList({ list: paste(LIST.replace("5.", "5. Omar")), week: list, roster })).toBe(false);
  });
});

describe("a pasted copy of the week's list, numbered 1, 2, 3 with no gaps (2026-11-07)", () => {
  // Bilal (slot 2) can't play, so the post reads "1. Alex / 2. Chris / 3. Dave":
  // the printed numbers are no longer the slot numbers. A pasted copy is read
  // by who is on it and where, never by matching a printed number to a slot.
  const members = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris"), reg(4, "Dave"), payg("Omar")];
  const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "DROPPED", 2), row("Chris", "CONFIRMED", 3), row("Dave", "CONFIRMED", 4)];
  const roster = [
    ...members.map((m) => ({ userId: m.userId, name: m.name, aliases: [] as string[] })),
    { userId: "u-rob", name: "Rob Admin", aliases: [] },
  ];
  const base = { members, rows, maxPlayers: 6, roster, matchMonth: 10, seeded: true };
  const paste = (lines: string[]) => parseMonthlyList(["List for October:", ...lines].join("\n"))!;
  const run = (lines: string[], senderUserId: string, over: Partial<typeof base> & { senderIsAdmin?: boolean } = {}) =>
    reconcileMonthPaste({ ...base, list: paste(lines), senderUserId, senderIsAdmin: false, ...over });
  const CANT = ["", "Paid but can't play", "1. Bilal"];

  it("a regular blanks his own line on the consecutive copy: he is out, nobody else", () => {
    expect(run(["1. Alex", "2. Chris", "3.", ...CANT], "u-dave").actions).toEqual([{ kind: "out", userId: "u-dave", name: "Dave", self: true, via: "blank" }]);
    expect(run(["1. Alex", "2.", "3. Dave", ...CANT], "u-chris").actions).toEqual([{ kind: "out", userId: "u-chris", name: "Chris", self: true, via: "blank" }]);
  });

  it("an organiser blanks somebody's line: that player is out, whatever slot number he holds", () => {
    expect(run(["1. Alex", "2.", "3. Dave", ...CANT], "u-rob", { senderIsAdmin: true }).actions).toEqual([
      { kind: "out", userId: "u-chris", name: "Chris", self: false, via: "blank" },
    ]);
    // Somebody else's blank is still not an OUT.
    expect(run(["1. Alex", "2.", "3. Dave", ...CANT], "u-alex").ignored).toEqual([{ name: "Chris", reason: "blank-by-other" }]);
  });

  it("a copy with the real slot numbers (posted before the change) still reads the same", () => {
    expect(run(["1. Alex", "3.", "4. Dave", ...CANT], "u-rob", { senderIsAdmin: true }).actions).toEqual([
      { kind: "out", userId: "u-chris", name: "Chris", self: false, via: "blank" },
    ]);
  });

  it("a blank that could be either of two missing players takes nobody out", () => {
    expect(run(["1. Alex", "2.", ...CANT], "u-rob", { senderIsAdmin: true }).actions).toEqual([]);
  });

  it("Omar (PAYG) took Bilal's slot 2: read in the post's order and in the group's own slot order", () => {
    const withOmar = [...rows, row("Omar", "CONFIRMED", 2)];
    const admin = { rows: withOmar, senderIsAdmin: true };
    // The post: "1. Alex / 2. Chris / 3. Dave", then pay as you go "4. Omar".
    // Chris's line blanked is Chris, not whoever holds slot 2.
    expect(run(["1. Alex", "2.", "3. Dave", "4. Omar (PAYG)", ...CANT], "u-rob", admin).actions).toEqual([
      { kind: "out", userId: "u-chris", name: "Chris", self: false, via: "blank" },
    ]);
    // The group's own list, Omar at his slot among the regulars: his line
    // blanked is Omar.
    expect(run(["1. Alex", "2.", "3. Chris", "4. Dave", ...CANT], "u-rob", admin).actions).toEqual([
      { kind: "out", userId: "u-omar", name: "Omar", self: false, via: "blank" },
    ]);
    // A paste whose names follow neither order blanks nobody.
    expect(run(["1. Dave", "2.", "3. Alex", "4. Chris", ...CANT], "u-rob", admin).actions).toEqual([]);
  });

  it("pasteShowsSameList: our own consecutive post pasted back is the same list", () => {
    const list = buildWeekList({ members, rows, maxPlayers: 6 });
    expect(pasteShowsSameList({ list: paste(["1. Alex", "2. Chris", "3. Dave", ...CANT]), week: list, roster })).toBe(true);
    expect(pasteShowsSameList({ list: paste(["1. Alex", "2. Chris", "3.", ...CANT]), week: list, roster })).toBe(false);
    expect(pasteShowsSameList({ list: paste(["1. Alex", "2. Chris", "3. Dave", "4. Omar", ...CANT]), week: list, roster })).toBe(false);
    expect(pasteShowsSameList({ list: paste(["1. Alex", "2. Chris", "3. Dave"]), week: list, roster })).toBe(false);
  });
});

describe("a regular who has left the group, and open places", () => {
  it("planOpenPlaceOffers: one offer per open place, naming the vacated slots first, never more than are open", () => {
    const members = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris")];
    const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "DROPPED", 2), row("Chris", "CONFIRMED", 3)];
    // 5 places, 2 in: 3 open. Bilal's slot is vacated; two were never held.
    expect(planOpenPlaceOffers({ members, rows, maxPlayers: 5, openOffers: [] })).toEqual(["u-bilal", null, null]);
    // One is already on offer for Bilal, one unnamed: one more.
    expect(planOpenPlaceOffers({ members, rows, maxPlayers: 5, openOffers: ["u-bilal", null] })).toEqual([null]);
    // Enough already.
    expect(planOpenPlaceOffers({ members, rows, maxPlayers: 5, openOffers: [null, null, null] })).toEqual([]);
    // Full squad.
    expect(planOpenPlaceOffers({ members, rows, maxPlayers: 2, openOffers: [] })).toEqual([]);
  });
});

describe("round 2 of the review", () => {
  const MEM = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris"), reg(4, "Dave")];

  describe("A: a regular who has left the group", () => {
    const members = [reg(1, "Alex"), reg(2, "Bilal", { left: true }), reg(3, "Chris")];

    it("is not seeded, and their slot number is free for somebody else", () => {
      const d = decideMonthlySeed({ members, targetRows: [], maxPlayers: 5 });
      expect(d.write.map((w) => w.userId)).toEqual(["u-alex", "u-chris"]);
      const rows = [row("Alex", "CONFIRMED", 1), row("Chris", "CONFIRMED", 3), row("Omar", "CONFIRMED", 9)];
      expect(decideSlotFor({ members, rows, maxPlayers: 5, userId: "u-omar" })?.slot).toBe(2);
      expect(buildWeekList({ members, rows: rows.slice(0, 2), maxPlayers: 5 }).paidCantPlay).toEqual([]);
    });

    it("KEEPS every credit they earned: leaving never voids one", () => {
      // Bilal dropped out of this game, was credited, and then left the group.
      const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "DROPPED", 2), row("Chris", "CONFIRMED", 3)];
      const existing = [{ id: "c1", userId: "u-bilal", voidedAt: null, voidedById: null, appliedMonthId: null, createdById: null }];
      for (const rule of ["any-miss", "filled-only", "none"] as const) {
        expect(decideMissedCredits({ rule, members, rows, maxPlayers: 5, existing }).voidIds).toEqual([]);
      }
      // Nor the credit of somebody who is no longer a member of the month at all.
      const gone = [{ id: "c2", userId: "u-gone", voidedAt: null, voidedById: null, appliedMonthId: null, createdById: null }];
      expect(decideMissedCredits({ rule: "any-miss", members, rows, maxPlayers: 5, existing: gone }).voidIds).toEqual([]);
    });

    it("earns no new credit for games after they left", () => {
      expect(decideMissedCredits({ rule: "any-miss", members, rows: [row("Alex", "CONFIRMED", 1)], maxPlayers: 5, existing: [] }).create).toEqual([]);
    });
  });

  describe("F: the seed's priority has two exceptions", () => {
    it("a regular who CHOSE the bench is not brought in over anybody, and is not credited for that week", () => {
      const d = decideMonthlySeed({
        members: MEM,
        targetRows: [
          { userId: "u-zed", status: "CONFIRMED", position: 1 },
          { userId: "u-alex", status: "BENCH", position: 2, choseBench: true },
        ],
        maxPlayers: 4,
      });
      expect(d.promote).toEqual([]);
      expect(d.bump).toEqual([]);
      const rows = [{ ...row("Alex", "BENCH", 2), choseBench: true }, row("Bilal", "CONFIRMED", 2)];
      expect(decideMissedCredits({ rule: "any-miss", members: MEM, rows, maxPlayers: 4, existing: [] }).create).toEqual([]);
      // Left there by the squad being full, he IS credited.
      const full = [row("Alex", "BENCH", 2), row("Bilal", "CONFIRMED", 2)];
      expect(decideMissedCredits({ rule: "any-miss", members: MEM, rows: full, maxPlayers: 4, existing: [] }).create).toEqual(["u-alex"]);
    });

    it("an organiser who is not on the month's list is never moved to the waiting list", () => {
      const d = decideMonthlySeed({
        members: MEM,
        targetRows: [
          { userId: "u-rob", status: "CONFIRMED", position: 1 },
          { userId: "u-zed", status: "CONFIRMED", position: 2 },
        ],
        maxPlayers: 4,
        protectedUserIds: ["u-rob"],
      });
      // Four regulars, four places, the organiser keeps his: three regulars
      // get in, Zed gives way, and the fourth regular waits.
      expect(d.bump).toEqual(["u-zed"]);
      expect(d.write.map((w) => [w.userId, w.status])).toEqual([
        ["u-alex", "CONFIRMED"],
        ["u-bilal", "CONFIRMED"],
        ["u-chris", "CONFIRMED"],
        ["u-dave", "BENCH"],
      ]);
    });
  });

  describe("C: a paste that matched nobody is not swallowed", () => {
    const members = [reg(1, "Alex"), reg(2, "Bilal"), payg("Omar")];
    const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "CONFIRMED", 2)];
    const roster = [
      { userId: "u-alex", name: "Alex", aliases: [] as string[] },
      { userId: "u-bilal", name: "Bilal", aliases: [] },
      { userId: "u-omar", name: "Omar Khan", aliases: [] },
      { userId: "u-gary", name: "Gary Holt", aliases: [] },
    ];
    const base = { members, rows, maxPlayers: 5, roster, matchMonth: 10, seeded: true, senderIsAdmin: false };
    const paste = (t: string) => parseMonthlyList(t)!;
    const LIST = "List for October:\n1. Alex\n2. Bilal\n3. X\n4.";

    it("the sender, not on the list, adds ONE new line sharing a word with their own name or WhatsApp name: it is them", () => {
      const a = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Big Gary")), senderUserId: "u-gary", senderNames: ["Gary Holt"] });
      expect(a.actions).toEqual([{ kind: "in", userId: "u-gary", name: "Big Gary", self: true, slot: 3 }]);
      expect(a.notAdded).toEqual([]);
      // By the WhatsApp name.
      const b = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Gaz H")), senderUserId: "u-gary", senderNames: ["Gary Holt", "Gaz"] });
      expect(b.actions).toEqual([{ kind: "in", userId: "u-gary", name: "Gaz H", self: true, slot: 3 }]);
    });

    it("round 3: the line must carry the sender's FIRST name (or whole name); a surname alone is not enough", () => {
      const surname = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Holt")), senderUserId: "u-gary", senderNames: ["Gary Holt"] });
      expect(surname.actions).toEqual([]);
      expect(surname.notAdded).toEqual([{ name: "Holt", reason: "unknown" }]);
      const other = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Dave Holt")), senderUserId: "u-gary", senderNames: ["Gary Holt"] });
      expect(other.actions).toEqual([]);
      const first = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Gary H")), senderUserId: "u-gary", senderNames: ["Gary Holt"] });
      expect(first.actions).toEqual([{ kind: "in", userId: "u-gary", name: "Gary H", self: true, slot: 3 }]);
    });

    it("round 3: before the seed, a re-paste of the game just played does not carry the sender's own line into next week", () => {
      const pre = { ...base, rows: [], seeded: false, selfBeforeSeed: false };
      const out = reconcileMonthPaste({
        ...pre,
        list: paste("List for October:\n1.\n2. Bilal (paid)\n\nPaid but can't play\n1. Alex"),
        senderUserId: "u-alex",
        senderNames: ["Alex"],
        members: [reg(1, "Alex"), reg(2, "Bilal", { paid: "none" }), payg("Omar")],
      });
      // Only the paid mark is read.
      expect(out.actions).toEqual([{ kind: "paid-claim", userId: "u-bilal", name: "Bilal", self: false, amountPence: null }]);
    });

    it("no shared word, two new lines, or a sender already on the list: nobody is registered, and the line is reported", () => {
      const noWord = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Gaz")), senderUserId: "u-gary", senderNames: ["Gary Holt"] });
      expect(noWord.actions).toEqual([]);
      expect(noWord.notAdded).toEqual([{ name: "Gaz", reason: "unknown" }]);
      const two = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Big Gary").replace("4.", "4. Tariq")), senderUserId: "u-gary", senderNames: ["Gary Holt"] });
      expect(two.actions).toEqual([]);
      const onList = reconcileMonthPaste({ ...base, list: paste(LIST.replace("X", "Big Alex")), senderUserId: "u-alex", senderNames: ["Alex"] });
      expect(onList.actions).toEqual([]);
    });

    it("BEFORE the seed the sender's OWN in and out are kept (for the seed to honour), nobody else's", () => {
      const pre = { ...base, rows: [], seeded: false };
      // A regular takes himself out of next week; and moves Bilal too.
      const out = reconcileMonthPaste({
        ...pre,
        list: paste("List for October:\n1.\n2.\n\nPaid but can't play\n1. Alex\n2. Bilal"),
        senderUserId: "u-alex",
        senderNames: ["Alex"],
      });
      expect(out.actions).toEqual([{ kind: "out", userId: "u-alex", name: "Alex", self: true, via: "cant-play" }]);
      // A regular whose own name is simply on the list needs nothing: the
      // seed puts him in. (No early row for every regular who pastes.)
      const own = reconcileMonthPaste({ ...pre, list: paste("List for October:\n1. Alex\n2. Bilal"), senderUserId: "u-alex", senderNames: ["Alex"] });
      expect(own.actions).toEqual([]);
      // A PAYG player writes himself in.
      const inn = reconcileMonthPaste({ ...pre, list: paste("List for October:\n1. Alex\n2. Bilal\n3. Omar (PAYG)"), senderUserId: "u-omar", senderNames: ["Omar Khan"] });
      expect(inn.actions).toEqual([{ kind: "in", userId: "u-omar", name: "Omar", self: true, slot: 3 }]);
    });
  });
});

describe("the bench on a pasted list (Kemal, 2026-11-09): a name added under it goes on the bench, a name taken off it comes off", () => {
  // Squad full (4): Alex, Bilal, Chris (regulars), Omar (PAYG). Zed and Will
  // on the bench, Zed first. Pete dropped. Ned is a PAYG member of the
  // month with no row. Tom is a club player who is not on the month; Rob
  // is an organiser.
  const members = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris"), payg("Omar"), payg("Zed"), payg("Will"), payg("Pete"), payg("Ned")];
  const rows = [
    row("Alex", "CONFIRMED", 1),
    row("Bilal", "CONFIRMED", 2),
    row("Chris", "CONFIRMED", 3),
    row("Omar", "CONFIRMED", 4),
    row("Zed", "BENCH", 5),
    row("Will", "BENCH", 6),
    row("Pete", "DROPPED", 7),
  ];
  const roster = [
    ...members.map((m) => ({ userId: m.userId, name: m.name, aliases: [] as string[] })),
    { userId: "u-tom", name: "Tom", aliases: [] as string[] },
    { userId: "u-rob", name: "Rob Admin", aliases: [] as string[] },
  ];
  const entry = (slot: number, name: string, facts?: MonthlyListEntry["facts"]): MonthlyListEntry => ({
    slot,
    raw: name,
    name,
    marks: { paid: false, paidAmountPence: null, tier: null, payg: false, paygDates: [] },
    ...(facts ? { facts } : {}),
  });
  const SQUAD = ["Alex", "Bilal", "Chris", "Omar"];
  const list = (p: { playing?: string[]; cant?: string[]; bench?: Array<string | MonthlyListEntry>; benchShown?: boolean } = {}): MonthlyList => ({
    month: { month: 10, year: null },
    slots: (p.playing ?? SQUAD).map((n, i) => entry(i + 1, n)),
    sections: {
      cantPlay: (p.cant ?? []).map((n, i) => entry(i + 1, n)),
      reserves: (p.bench ?? ["Zed", "Will"]).map((n, i) => (typeof n === "string" ? entry(i + 1, n) : n)),
      other: [],
    },
    ...(p.benchShown !== undefined ? { benchShown: p.benchShown } : {}),
  });
  const run = (l: MonthlyList, sender: string, over: { senderIsAdmin?: boolean; seeded?: boolean; benchSeen?: Set<string>; rows?: typeof rows } = {}) =>
    reconcileMonthPaste({
      list: l,
      members,
      rows: over.rows ?? rows,
      maxPlayers: 4,
      roster,
      matchMonth: 10,
      seeded: over.seeded ?? true,
      senderUserId: `u-${sender.toLowerCase()}`,
      senderIsAdmin: over.senderIsAdmin ?? false,
      benchSeen: over.benchSeen,
    });

  it("a member adds himself under the bench: he goes on it", () => {
    expect(run(list({ bench: ["Zed", "Will", "Ned"] }), "Ned").actions).toEqual([{ kind: "bench", userId: "u-ned", name: "Ned", self: true }]);
  });

  it("anybody may write a player of this month under the bench, as for a numbered line (the player is told, and can undo it)", () => {
    expect(run(list({ bench: ["Zed", "Will", "Ned"] }), "Alex").actions).toEqual([{ kind: "bench", userId: "u-ned", name: "Ned", self: false }]);
  });

  it("a club player who is not on the month: only an organiser's line puts him on the bench", () => {
    const l = list({ bench: ["Zed", "Will", "Tom"] });
    const byMember = run(l, "Alex");
    expect(byMember.actions).toEqual([]);
    expect(byMember.notAdded).toEqual([{ name: "Tom", reason: "not-in-month" }]);
    expect(run(l, "Rob", { senderIsAdmin: true }).actions).toEqual([{ kind: "bench", userId: "u-tom", name: "Tom", self: false }]);
  });

  it("a guest written under the bench is a guest on the bench; a name that is nobody and no guest is reported", () => {
    const gary = entry(3, "Gary", { memberId: null, guest: true, hostUserId: "u-alex", games: null, newbie: false });
    expect(run(list({ bench: ["Zed", "Will", gary] }), "Alex").actions).toEqual([{ kind: "guest", name: "Gary", hostUserId: "u-alex", slot: 3, bench: true }]);
    const out = run(list({ bench: ["Zed", "Will", "Nobody Known"] }), "Alex");
    expect(out.actions).toEqual([]);
    expect(out.notAdded).toEqual([{ name: "Nobody Known", reason: "unknown" }]);
  });

  it("a player who dropped comes back on the bench only by his own paste", () => {
    const l = list({ bench: ["Zed", "Will", "Pete"] });
    expect(run(l, "Pete").actions).toEqual([{ kind: "bench", userId: "u-pete", name: "Pete", self: true }]);
    const other = run(l, "Alex");
    expect(other.actions).toEqual([]);
    expect(other.ignored).toEqual([{ name: "Pete", reason: "stale-readd" }]);
  });

  it("a squad player moved under the bench goes to the bench, as one moved under can't play goes out; never on an old copy", () => {
    const l = list({ playing: ["Alex", "Bilal", "Omar"], bench: ["Zed", "Will", "Chris"] });
    expect(run(l, "Chris").actions).toEqual([{ kind: "bench", userId: "u-chris", name: "Chris", self: true }]);
    expect(run(l, "Alex").actions).toEqual([{ kind: "bench", userId: "u-chris", name: "Chris", self: false }]);
    // An old copy (Pete, who dropped, still in a numbered line) moves nobody else.
    const old = run(list({ playing: ["Alex", "Bilal", "Omar", "Pete"], bench: ["Zed", "Will", "Chris"] }), "Rob", { senderIsAdmin: true });
    expect(old.actions).toEqual([]);
    expect(old.ignored).toEqual(expect.arrayContaining([{ name: "Chris", reason: "old-copy" }]));
  });

  it("the bench as it is changes nothing", () => {
    const out = run(list(), "Alex");
    expect(out.actions).toEqual([]);
    expect(out.ignored).toEqual([]);
  });

  it("a bencher taken off the pasted bench: off it by his own paste, or an organiser's once the group has seen him there", () => {
    const l = list({ bench: ["Will"] });
    expect(run(l, "Zed").actions).toEqual([{ kind: "out", userId: "u-zed", name: "Zed", self: true, via: "off-bench" }]);
    expect(run(l, "Rob", { senderIsAdmin: true, benchSeen: new Set(["u-zed", "u-will"]) }).actions).toEqual([
      { kind: "out", userId: "u-zed", name: "Zed", self: false, via: "off-bench" },
    ]);
    // He went on the bench after the list the group last saw: the copy may
    // simply be older than him. Nothing.
    const unseen = run(l, "Rob", { senderIsAdmin: true, benchSeen: new Set(["u-will"]) });
    expect(unseen.actions).toEqual([]);
    // Somebody else's: left alone, as a blanked line is.
    const other = run(l, "Alex", { benchSeen: new Set(["u-zed", "u-will"]) });
    expect(other.actions).toEqual([]);
    expect(other.ignored).toEqual([{ name: "Zed", reason: "blank-by-other" }]);
  });

  it("the last bencher taken off: the paste still shows a bench (empty), and he comes off", () => {
    expect(run(list({ bench: [], benchShown: true }), "Zed").actions).toEqual([
      { kind: "out", userId: "u-zed", name: "Zed", self: true, via: "off-bench" },
    ]);
  });

  it("a paste with no bench part takes nobody off the bench", () => {
    expect(run(list({ bench: [], benchShown: false }), "Zed").actions).toEqual([]);
    expect(run(list({ bench: [] }), "Zed").actions).toEqual([]);
  });

  it("a bencher moved under can't play is out once, by that line, not 'taken off the bench' as well", () => {
    expect(run(list({ bench: ["Will"], cant: ["Zed"] }), "Zed").actions).toEqual([{ kind: "out", userId: "u-zed", name: "Zed", self: true, via: "cant-play" }]);
  });

  it("before the week is seeded the bench is not touched", () => {
    expect(run(list({ bench: ["Zed", "Will", "Ned"] }), "Ned", { seeded: false }).actions).toEqual([]);
    expect(run(list({ bench: ["Will"] }), "Zed", { seeded: false }).actions).toEqual([]);
  });

  it("pasteShowsSameList: with a bench part, the bench must match too; with none, the bench is not compared", () => {
    const week = buildWeekList({ members, rows, maxPlayers: 4 });
    expect(pasteShowsSameList({ list: list(), week, roster })).toBe(true);
    expect(pasteShowsSameList({ list: list({ bench: ["Will", "Zed"] }), week, roster })).toBe(true);
    expect(pasteShowsSameList({ list: list({ bench: ["Zed"] }), week, roster })).toBe(false);
    expect(pasteShowsSameList({ list: list({ bench: ["Zed", "Will", "Ned"] }), week, roster })).toBe(false);
    expect(pasteShowsSameList({ list: list({ bench: [], benchShown: true }), week, roster })).toBe(false);
    expect(pasteShowsSameList({ list: list({ bench: [], benchShown: false }), week, roster })).toBe(true);
  });
});

describe("round 3 of the review", () => {
  describe("the collector's yes to a fee question that was never staged", () => {
    const NOW = new Date("2026-10-12T21:10:00.000Z");
    const ok = {
      reply: "yes" as const,
      askedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
      unsent: false,
      declined: false,
      otherDmSinceAsk: false,
      now: NOW,
    };
    it("stages only an explicit yes, right after a question that was claimed and not known to have failed", () => {
      expect(mayStagePaygFeeOnReply(ok)).toBe(true);
    });
    it("never after the collector declined", () => {
      expect(mayStagePaygFeeOnReply({ ...ok, declined: true })).toBe(false);
    });
    it("never when the question is known not to have been sent", () => {
      expect(mayStagePaygFeeOnReply({ ...ok, unsent: true })).toBe(false);
    });
    it("never when no question was asked, or it was asked a while ago", () => {
      expect(mayStagePaygFeeOnReply({ ...ok, askedAt: null })).toBe(false);
      expect(mayStagePaygFeeOnReply({ ...ok, askedAt: new Date(NOW.getTime() - FEE_REPLY_WINDOW_MS - 1000) })).toBe(false);
      expect(mayStagePaygFeeOnReply({ ...ok, askedAt: new Date(NOW.getTime() - FEE_REPLY_WINDOW_MS) })).toBe(true);
    });
    it("never when MatchTime has DMed the collector something else since: the yes may be for that", () => {
      expect(mayStagePaygFeeOnReply({ ...ok, otherDmSinceAsk: true })).toBe(false);
    });
    it("never for anything that is not the explicit yes (a no, chatter, an amount: the weekly path stages an amount)", () => {
      for (const reply of ["no", null] as const) expect(mayStagePaygFeeOnReply({ ...ok, reply })).toBe(false);
    });
  });
});
