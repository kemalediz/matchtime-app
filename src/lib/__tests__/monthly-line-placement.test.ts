/**
 * WHO EACH UNPLACED LINE OF A PASTED MONTHLY LIST IS, BEFORE THE
 * RECONCILE (review of #574, round 3, B2).
 *
 * The reader's "" on a line means nobody, or somebody it was not sure of.
 * Every such line goes to who-is-who first, and its answer is written on
 * the line: a sure member becomes the line's member (the reconcile's rules
 * then apply to him as to anyone), nobody stays nobody (new or guest), and
 * anything else is UNCLEAR, with the members it could be.
 */
import { describe, expect, it } from "vitest";
import { placeListLines, unplacedLineNames } from "../monthly-line-placement";
import type { MonthlyList, MonthlyListEntry } from "../monthly-list";
import type { PersonPick } from "../pipeline/who-is-who";

const marks = { paid: false, paidAmountPence: null, tier: null, payg: false, paygDates: [] };
const line = (name: string, memberId: string | null = null, guest = false): MonthlyListEntry => ({
  slot: 1,
  raw: name,
  name,
  marks,
  facts: { memberId, guest, hostUserId: null, games: null, newbie: false },
});
const list = (slots: MonthlyListEntry[], reserves: MonthlyListEntry[] = []): MonthlyList => ({
  month: null,
  slots,
  sections: { cantPlay: [], reserves, other: [] },
});
const ROSTER = new Set(["u-davide", "u-mo1", "u-mo2", "u-tom"]);

describe("unplacedLineNames", () => {
  it("every named line with no member the club has, in every part; blank lines and placed lines are not asked", () => {
    const l = list([line("Tom", "u-tom"), line(""), line("Davdie"), line("Ghost", "u-gone")], [line("Mo")]);
    expect(unplacedLineNames(l, ROSTER)).toEqual(["Davdie", "Ghost", "Mo"]);
  });
});

describe("placeListLines", () => {
  const picks = new Map<string, PersonPick>([
    ["Davdie", { kind: "member", userId: "u-davide" }],
    ["Mo", { kind: "ambiguous", userIds: ["u-mo1", "u-mo2", "u-not-ours"] }],
    ["Luca", { kind: "none" }],
    ["Zed", { kind: "unidentified", why: "the call failed" }],
  ]);

  it("a sure member: the line is his (a guest mark the reader put on it does not make a member a guest)", () => {
    const out = placeListLines(list([line("Davdie", null, true)]), picks, ROSTER);
    expect(out.slots[0].facts).toMatchObject({ memberId: "u-davide", guest: false });
    expect(out.slots[0].facts?.unclear).toBeUndefined();
  });

  it("nobody: stays nobody, its guest mark kept", () => {
    const out = placeListLines(list([line("Luca", null, true)]), picks, ROSTER);
    expect(out.slots[0].facts).toMatchObject({ memberId: null, guest: true });
    expect(out.slots[0].facts?.unclear).toBeUndefined();
  });

  it("not sure: UNCLEAR with only the club's members it could be", () => {
    const out = placeListLines(list([], [line("Mo")]), picks, ROSTER);
    expect(out.sections.reserves[0].facts).toMatchObject({ memberId: null, unclear: { candidates: ["u-mo1", "u-mo2"] } });
  });

  it("no answer: UNCLEAR, could be anybody", () => {
    const out = placeListLines(list([line("Zed")]), picks, ROSTER);
    expect(out.slots[0].facts?.unclear).toEqual({ candidates: [] });
  });

  it("a line the reader already placed is never touched", () => {
    const l = list([line("Tom", "u-tom")]);
    expect(placeListLines(l, new Map([["Tom", { kind: "none" }]]), ROSTER).slots[0]).toBe(l.slots[0]);
  });
});
