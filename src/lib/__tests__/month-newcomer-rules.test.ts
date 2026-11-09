/**
 * AN ORGANISER ADDS SOMEBODY TO A RUNNING MONTH (Kemal, 2026-11-03), the
 * pure rules: who a name is, what the organiser's re-posted list does with
 * a new line, and what his "Zak is 3" answer does. No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  classifyNewcomer,
  isNamedMember,
  MAX_NEW_PLAYERS_PER_PASTE,
  newcomerLineOf,
  parseNewcomerQuestion,
  resolveNewcomerMatches,
  type NewcomerQuestion,
} from "../month-newcomer-rules";
import { reconcileMonthPaste, type WeekMember, type WeekRow } from "../monthly-week-rules";
import { entryResolver } from "../month-signup-rules";
import type { MonthlyList, MonthlyListEntry } from "../monthly-list";

const entry = (
  slot: number | null,
  name: string,
  facts: Partial<NonNullable<MonthlyListEntry["facts"]>> = {},
  marks: Partial<MonthlyListEntry["marks"]> = {},
): MonthlyListEntry => ({
  slot,
  raw: name,
  name,
  marks: { paid: false, paidAmountPence: null, tier: null, payg: false, paygDates: [], ...marks },
  facts: { memberId: null, guest: false, hostUserId: null, games: null, newbie: false, ...facts },
});
const listOf = (slots: MonthlyListEntry[], cantPlay: MonthlyListEntry[] = []): MonthlyList => ({
  month: { month: 11, year: null },
  slots,
  sections: { cantPlay, reserves: [], other: [] },
});

// Davide (organiser) and Shane on the month; Tom a named club member who is
// not; Luca a member with no name; Nabz a nameless REGULAR known by an alias.
const roster = [
  { userId: "u-davide", name: "Davide Russo", aliases: [] },
  { userId: "u-shane", name: "Shane Walton", aliases: [] },
  { userId: "u-tom", name: "Tom Hale", aliases: [] },
  { userId: "u-luca", name: null, aliases: [] },
  { userId: "u-nabz", name: null, aliases: ["nabz"] },
];
const reg = (n: number, id: string, name: string): WeekMember => ({ userId: id, name, kind: "regular", slot: n, paid: "confirmed", absent: false, paygDated: false, left: false });
const members = [reg(1, "u-davide", "Davide Russo"), reg(2, "u-nabz", "Nabz"), reg(3, "u-shane", "Shane Walton")];
const rows: WeekRow[] = members.map((m, i) => ({ userId: m.userId, name: m.name, status: "CONFIRMED", position: i + 1 }));
const BASE = [entry(1, "Davide", { memberId: "u-davide" }), entry(2, "Nabz", { memberId: "u-nabz" }), entry(3, "Shane", { memberId: "u-shane" })];
const run = (extra: MonthlyListEntry[], opts: { sender?: string; admin?: boolean; seeded?: boolean } = {}) =>
  reconcileMonthPaste({
    list: listOf([...BASE, ...extra]),
    members,
    rows,
    maxPlayers: 14,
    roster,
    matchMonth: 11,
    seeded: opts.seeded ?? true,
    senderUserId: opts.sender ?? "u-davide",
    senderIsAdmin: opts.admin ?? true,
  });

describe("who a name is", () => {
  it("named means a usable name or an alias here; a phone number or nothing is not a name", () => {
    expect(isNamedMember({ userId: "a", name: "Tom" })).toBe(true);
    expect(isNamedMember({ userId: "a", name: null, aliases: ["nabz"] })).toBe(true);
    expect(isNamedMember({ userId: "a", name: "+44 7700 900123" })).toBe(false);
    expect(isNamedMember({ userId: "a", name: null, aliases: [] })).toBe(false);
  });

  it("a named member joins, a nameless one could be him (ask), nobody is new, already on is nothing", () => {
    const onMonth = new Set(["u-davide", "u-nabz"]);
    expect(classifyNewcomer({ memberId: "u-tom", name: "Tom", roster, onMonth })).toEqual({ kind: "join", userId: "u-tom" });
    expect(classifyNewcomer({ memberId: "u-luca", name: "Luca", roster, onMonth })).toEqual({ kind: "ask", candidateUserId: "u-luca" });
    expect(classifyNewcomer({ memberId: null, name: "Zak", roster, onMonth })).toEqual({ kind: "new" });
    expect(classifyNewcomer({ memberId: "u-nabz", name: "Nabz", roster, onMonth })).toEqual({ kind: "on-month", userId: "u-nabz" });
    expect(classifyNewcomer({ memberId: null, name: "Dan", ambiguous: true, roster, onMonth })).toEqual({ kind: "unclear" });
    expect(classifyNewcomer({ memberId: null, name: "", roster, onMonth })).toEqual({ kind: "unclear" });
  });

  it("the line's facts: says paid with the amount, 4 only; PAYG is never paid for the month", () => {
    expect(newcomerLineOf(entry(14, "Tom", { games: 4 }, { paid: true, paidAmountPence: 2250 }))).toEqual({ payg: false, paygDays: [], paid: true, paidPence: 2250, games: 4 });
    expect(newcomerLineOf(entry(14, "Tom", {}, { payg: true, paid: true, paygDates: [{ day: 16, month: null }] }))).toEqual({ payg: true, paygDays: [16], paid: false, paidPence: null, games: null });
  });
});

describe("the organiser re-posts the month's list in a running month with a new line", () => {
  it("N1: a named club member who is not on the month joins it, with his line", () => {
    const r = run([entry(14, "Tom", { memberId: "u-tom" }, { paid: true })]);
    expect(r.actions).toEqual([{ kind: "join", userId: "u-tom", name: "Tom", slot: 14, line: { payg: false, paygDays: [], paid: true, paidPence: null, games: null } }]);
    expect(r.notAdded).toEqual([]);
  });

  it("N2: a member with no name the reader matched is asked about, never added on that reading", () => {
    const r = run([entry(14, "Luca", { memberId: "u-luca" }, { paid: true })]);
    expect(r.actions).toEqual([{ kind: "ask", name: "Luca", slot: 14, candidateUserId: "u-luca", line: expect.objectContaining({ paid: true }) }]);
    expect(r.notAdded).toEqual([]);
  });

  it("N3: a name that is nobody (nobody brings him) is a new player, at most a few per paste; the rest are refused", () => {
    const r = run([entry(14, "Zak", { guest: true }, { paid: true })]);
    expect(r.actions).toEqual([{ kind: "new", name: "Zak", slot: 14, line: expect.objectContaining({ paid: true }) }]);
    const many = run(Array.from({ length: 6 }, (_, i) => entry(14 + i, `Stranger${i}`, { guest: true })));
    expect(many.actions.filter((a) => a.kind === "new")).toHaveLength(MAX_NEW_PLAYERS_PER_PASTE);
    expect(many.guestsRefused).toHaveLength(6 - MAX_NEW_PLAYERS_PER_PASTE);
  });

  it("somebody BROUGHT for a game ('Jon extra') is still a guest for that game, never a regular", () => {
    const r = run([entry(14, "Jon extra", { guest: true, hostUserId: "u-shane" })]);
    expect(r.actions).toEqual([{ kind: "guest", name: "Jon extra", hostUserId: "u-shane", slot: 14 }]);
  });

  it("N4: a player (not an organiser) adds nobody: Tom is not-in-month, as before", () => {
    const r = run([entry(14, "Tom", { memberId: "u-tom" })], { sender: "u-shane", admin: false });
    expect(r.actions).toEqual([]);
    expect(r.notAdded).toEqual([{ name: "Tom", reason: "not-in-month" }]);
  });

  it("N6: the unchanged list with nameless regulars matched by the reader creates nobody and changes nothing", () => {
    const r = run([]);
    expect(r.actions).toEqual([]);
    expect(r.notAdded).toEqual([]);
    expect(r.guestsRefused).toEqual([]);
  });

  // Review of #574: the reader's refs are the only authority. A line the
  // reader called a guest is nobody of the club, even when the name is a
  // regular's alias: code no longer looks it up and overrules the reader.
  // It is still never a new player, and the paste changes nothing.
  it("N6: a line the reader called a guest is nobody, even with a regular's alias, and never a new player", () => {
    const resolve = entryResolver(roster, new Set(members.map((m) => m.userId)));
    expect(resolve(entry(2, "Nabz", { guest: true }))).toEqual({ kind: "none" });
    expect(resolve(entry(2, "Nabz", { memberId: "u-nabz" }))).toEqual({ kind: "one", userId: "u-nabz" });
    const r = reconcileMonthPaste({
      list: listOf([entry(1, "Davide", { memberId: "u-davide" }), entry(2, "Nabz", { guest: true }), entry(3, "Shane", { memberId: "u-shane" })]),
      members,
      rows,
      maxPlayers: 14,
      roster,
      matchMonth: 11,
      seeded: true,
      senderUserId: "u-davide",
      senderIsAdmin: true,
    });
    // The rule proposes the line as new; the apply step asks who-is-who
    // before anybody is created (`monthly-paste.ts`), which places Nabz on
    // the regular, so no duplicate is made.
    expect(r.actions.map((a) => [a.kind, "name" in a ? a.name : null])).toEqual([["new", "Nabz"]]);
  });

  it("N5: a new line and a name moved under can't play, in one paste", () => {
    const r = reconcileMonthPaste({
      list: listOf([entry(1, "Davide", { memberId: "u-davide" }), entry(2, "Nabz", { memberId: "u-nabz" }), entry(14, "Tom", { memberId: "u-tom" })], [entry(null, "Shane", { memberId: "u-shane" })]),
      members,
      rows,
      maxPlayers: 14,
      roster,
      matchMonth: 11,
      seeded: true,
      senderUserId: "u-davide",
      senderIsAdmin: true,
    });
    expect(r.actions.map((a) => a.kind).sort()).toEqual(["join", "out"]);
  });

  it("before the week is seeded an organiser's new line adds nobody (the seed comes first)", () => {
    expect(run([entry(14, "Tom", { memberId: "u-tom" })], { seeded: false }).actions).toEqual([]);
    expect(run([entry(14, "Zak", { guest: true })], { seeded: false }).actions).toEqual([]);
  });
});

describe("his answer to 'who is this?'", () => {
  const line = { payg: false, paygDays: [], paid: true, paidPence: null, games: null };
  const q: NewcomerQuestion = {
    v: 1,
    orgId: "o",
    monthId: "m",
    dm: "the DM",
    names: [
      { ref: "u1", name: "Zak", userId: "u-zak-new", line },
      { ref: "u2", name: "Luca", userId: null, line },
    ],
    nameless: [
      { n: 1, userId: "u-luca" },
      { n: 2, userId: "u-p11" },
    ],
  };

  it("a new player matched to a member is folded into him; a name nobody was added for links the member", () => {
    expect(resolveNewcomerMatches(q, [{ listed: "u1", userId: "u-p11" }, { listed: "u2", userId: "u-luca" }])).toEqual([
      { kind: "merge", ref: "u1", name: "Zak", fromUserId: "u-zak-new", toUserId: "u-p11" },
      { kind: "link", ref: "u2", name: "Luca", userId: "u-luca", line },
    ]);
  });

  it("each name once, each member once; an unknown ref is nothing", () => {
    expect(resolveNewcomerMatches(q, [{ listed: "u1", userId: "u-p11" }, { listed: "u2", userId: "u-p11" }, { listed: "u9", userId: "u-luca" }])).toHaveLength(1);
  });

  it("the stored question round-trips, and anything else is not one", () => {
    expect(parseNewcomerQuestion(JSON.stringify(q))).toEqual(q);
    expect(parseNewcomerQuestion("not json")).toBeNull();
    expect(parseNewcomerQuestion(JSON.stringify({ v: 2 }))).toBeNull();
    expect(parseNewcomerQuestion(null)).toBeNull();
  });
});
