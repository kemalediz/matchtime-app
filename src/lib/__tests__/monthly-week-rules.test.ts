/**
 * Monthly squad, slice 5: the weekly flow's pure rules
 * (MDs/monthly-squad-plan-2026-10-05.md, sections 5 and 6.2).
 * No database, no clock, no model. Made-up names throughout.
 */
import { describe, it, expect } from "vitest";
import { parseMonthlyList } from "../monthly-list";
import {
  LIST_REPOST_FLOOR_MS,
  buildWeekList,
  decideListPost,
  decideMissedCredits,
  decideMonthlySeed,
  decideSlotFor,
  pasteShowsSameList,
  paygPoolOfferAllowed,
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
    const d = decideMonthlySeed({ members: MEMBERS, targetRows: [{ userId: "u-zed", status: "CONFIRMED" }], maxPlayers: 3 });
    expect(d.write.map((w) => [w.userId, w.status])).toEqual([
      ["u-alex", "CONFIRMED"],
      ["u-bilal", "CONFIRMED"],
      ["u-chris", "BENCH"],
      ["u-dave", "BENCH"],
    ]);
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
    expect(decideMissedCredits({ ...base, rule: "any-miss" })).toEqual({ create: ["u-bilal"], voidIds: [] });
  });

  it("filled-only: only once somebody has taken the place", () => {
    expect(decideMissedCredits({ ...base, rule: "filled-only" })).toEqual({ create: [], voidIds: [] });
    const filled = [...rows, row("Omar", "CONFIRMED", 2)];
    expect(decideMissedCredits({ ...base, rows: filled, rule: "filled-only" })).toEqual({ create: ["u-bilal"], voidIds: [] });
  });

  it("none: never", () => {
    expect(decideMissedCredits({ ...base, rule: "none" })).toEqual({ create: [], voidIds: [] });
  });

  it("is idempotent: a credit that exists is not written again", () => {
    const existing = [{ id: "c1", userId: "u-bilal", voidedAt: null, voidedById: null, appliedMonthId: null, createdById: null }];
    expect(decideMissedCredits({ ...base, rule: "any-miss", existing })).toEqual({ create: [], voidIds: [] });
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
    expect(decideMissedCredits({ ...base, rule: "any-miss", existing })).toEqual({ create: [], voidIds: [] });
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

  it("never between 22:00 and 07:59 London", () => {
    expect(decideListPost({ ...base, now: at("2026-10-08T21:00:00.000Z") })).toBeNull(); // 22:00 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T06:59:00.000Z") })).toBeNull(); // 07:59 BST
    expect(decideListPost({ ...base, now: at("2026-10-08T07:00:00.000Z") })).toBe("change"); // 08:00 BST
  });

  it("always once on match morning, even with nothing changed", () => {
    const same = { ...base, lastShownHash: "h2", lastPostAt: at("2026-10-09T10:00:00.000Z") };
    expect(decideListPost({ ...same, now: at("2026-10-12T07:30:00.000Z") })).toBe("morning"); // 08:30 BST
    expect(decideListPost({ ...same, now: at("2026-10-12T12:30:00.000Z") })).toBeNull(); // afternoon
    // already posted this morning
    expect(decideListPost({ ...same, lastPostAt: at("2026-10-12T07:10:00.000Z"), now: at("2026-10-12T08:30:00.000Z") })).toBeNull();
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

describe("reconcileMonthPaste (plan 6.2, a running month)", () => {
  const members = [reg(1, "Alex"), reg(2, "Bilal"), reg(3, "Chris", { paid: "none" }), reg(4, "Dave")];
  const rows = [row("Alex", "CONFIRMED", 1), row("Bilal", "CONFIRMED", 2), row("Chris", "CONFIRMED", 3), row("Dave", "CONFIRMED", 4)];
  const roster = [
    ...members.map((m) => ({ userId: m.userId, name: m.name, aliases: [] as string[] })),
    { userId: "u-omar", name: "Omar Khan", aliases: [] },
    { userId: "u-rob", name: "Rob Admin", aliases: [] },
    { userId: "u-sam1", name: "Sam One", aliases: [] },
    { userId: "u-sam2", name: "Sam Two", aliases: [] },
  ];
  const base = { members, rows, maxPlayers: 6, roster, matchMonth: 10 };
  const paste = (text: string) => parseMonthlyList(text)!;
  const LIST = ["List for October:", "1. Alex (paid)", "2. Bilal (paid)", "3. Chris", "4. Dave (paid)", "5.", "6."].join("\n");

  it("a paste that restates the list changes nothing", () => {
    const r = reconcileMonthPaste({ ...base, list: paste(LIST), senderUserId: "u-alex", senderIsAdmin: false });
    expect(r.actions).toEqual([]);
    expect(r.ignored).toEqual([]);
  });

  it("a member adds their own name: in for this week", () => {
    const text = LIST.replace("5.", "5. Omar (PAYG)");
    const r = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-omar", senderIsAdmin: false });
    expect(r.actions).toEqual([{ kind: "in", userId: "u-omar", name: "Omar", self: true, slot: 5, teachAlias: null }]);
  });

  it("an unknown name added by a sender who is not on the list is the sender, and teaches the alias", () => {
    const text = LIST.replace("5.", "5. Big O");
    const r = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-omar", senderIsAdmin: false });
    expect(r.actions).toEqual([{ kind: "in", userId: "u-omar", name: "Big O", self: true, slot: 5, teachAlias: "Big O" }]);
  });

  it("an unknown name added by somebody already on the list is a new person, for the route to resolve", () => {
    const text = LIST.replace("5.", "5. Tariq");
    const r = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-alex", senderIsAdmin: false });
    expect(r.actions).toEqual([{ kind: "in", userId: null, name: "Tariq", self: false, slot: 5, teachAlias: null }]);
  });

  it("a name that fits two players is skipped, never guessed", () => {
    const text = LIST.replace("5.", "5. Sam");
    const r = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-alex", senderIsAdmin: false });
    expect(r.actions).toEqual([]);
    expect(r.ignored).toEqual([{ name: "Sam", reason: "ambiguous" }]);
  });

  it("D4: moving somebody else under 'Paid but can't play' is applied, and flagged as not their own doing", () => {
    const text = ["List for October:", "1. Alex (paid)", "2.", "3. Chris", "4. Dave (paid)", "", "Paid but can't play", "1. Bilal"].join("\n");
    const r = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-alex", senderIsAdmin: false });
    expect(r.actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: false, via: "cant-play" }]);
  });

  it("moving yourself there is your own OUT", () => {
    const text = ["List for October:", "1. Alex (paid)", "2.", "3. Chris", "4. Dave (paid)", "", "Paid but can't play", "1. Bilal"].join("\n");
    const r = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-bilal", senderIsAdmin: false });
    expect(r.actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: true, via: "cant-play" }]);
  });

  it("a blanked line is an OUT only from the player or an admin; from anyone else it is an old copy", () => {
    const text = LIST.replace("2. Bilal (paid)", "2.");
    const own = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-bilal", senderIsAdmin: false });
    expect(own.actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: true, via: "blank" }]);
    const admin = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-rob", senderIsAdmin: true });
    expect(admin.actions).toEqual([{ kind: "out", userId: "u-bilal", name: "Bilal", self: false, via: "blank" }]);
    const other = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-alex", senderIsAdmin: false });
    expect(other.actions).toEqual([]);
    expect(other.ignored).toEqual([{ name: "Bilal", reason: "blank-by-other" }]);
  });

  it("a name simply missing is ignored", () => {
    const text = ["List for October:", "1. Alex (paid)", "3. Chris", "4. Dave (paid)"].join("\n");
    const r = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-alex", senderIsAdmin: false });
    expect(r.actions).toEqual([]);
  });

  it("an old copy cannot bring back a player who dropped; the player or an admin can", () => {
    const dropped = rows.map((r) => (r.userId === "u-bilal" ? { ...r, status: "DROPPED" as const } : r));
    const args = { ...base, rows: dropped, list: paste(LIST) };
    const stale = reconcileMonthPaste({ ...args, senderUserId: "u-alex", senderIsAdmin: false });
    expect(stale.actions).toEqual([]);
    expect(stale.ignored).toEqual([{ name: "Bilal", reason: "stale-readd" }]);
    const own = reconcileMonthPaste({ ...args, senderUserId: "u-bilal", senderIsAdmin: false });
    expect(own.actions).toEqual([{ kind: "in", userId: "u-bilal", name: "Bilal", self: true, slot: 2, teachAlias: null }]);
    const admin = reconcileMonthPaste({ ...args, senderUserId: "u-rob", senderIsAdmin: true });
    expect(admin.actions).toEqual([{ kind: "in", userId: "u-bilal", name: "Bilal", self: false, slot: 2, teachAlias: null }]);
  });

  it("D3: a new paid mark is a claim, whoever wrote it, and a missing mark removes nothing", () => {
    const text = LIST.replace("3. Chris", "3. Chris (Paid £22.50)").replace("1. Alex (paid)", "1. Alex");
    const own = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-chris", senderIsAdmin: false });
    expect(own.actions).toEqual([{ kind: "paid-claim", userId: "u-chris", name: "Chris", self: true, amountPence: 2250 }]);
    const other = reconcileMonthPaste({ ...base, list: paste(text), senderUserId: "u-alex", senderIsAdmin: false });
    expect(other.actions).toEqual([{ kind: "paid-claim", userId: "u-chris", name: "Chris", self: false, amountPence: 2250 }]);
  });

  it("a paid mark on a PAYG line is not a claim for the month", () => {
    const m = [...members, payg("Omar")];
    const r2 = [...rows, row("Omar", "CONFIRMED", 5)];
    const text = LIST.replace("5.", "5. Omar (PAYG, paid £8)");
    const r = reconcileMonthPaste({ ...base, members: m, rows: r2, list: paste(text), senderUserId: "u-omar", senderIsAdmin: false });
    expect(r.actions).toEqual([]);
  });

  it("a list for another month is not this month's list", () => {
    const r = reconcileMonthPaste({
      ...base,
      list: paste(LIST.replace("October", "November").replace("5.", "5. Omar")),
      senderUserId: "u-omar",
      senderIsAdmin: false,
    });
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
