import { describe, expect, it } from "vitest";
import {
  guestFeePounds,
  monthlyPlacesOpen,
} from "../monthly-week-asks-rules";
import type { WeekMember, WeekRow } from "../monthly-week-rules";

const reg = (userId: string, slot: number, extra: Partial<WeekMember> = {}): WeekMember => ({
  userId,
  name: userId,
  kind: "regular",
  slot,
  paid: "confirmed",
  absent: false,
  paygDated: false,
  ...extra,
});
const payg = (userId: string, extra: Partial<WeekMember> = {}): WeekMember => ({
  userId,
  name: userId,
  kind: "payg",
  slot: null,
  paid: "none",
  absent: false,
  paygDated: false,
  ...extra,
});
const row = (userId: string, status: WeekRow["status"], position = 0): WeekRow => ({ userId, name: userId, status, position });


describe("monthlyPlacesOpen: the places a pool or partner ask may fill in a monthly week", () => {
  it("seeded: the week list's own count (CONFIRMED against the size), so the ask and the list agree", () => {
    const members = [reg("a", 1), reg("b", 2), reg("c", 3, { absent: true })];
    const rows = [row("a", "CONFIRMED", 1), row("b", "CONFIRMED", 2), row("c", "DROPPED", 3)];
    expect(monthlyPlacesOpen({ members, rows, maxPlayers: 4, seeded: true })).toBe(2);
  });

  it("NOT seeded yet (the night after a game): the regulars who will be put in are not open places", () => {
    // 14 regulars, two away; nobody has a row yet. Naive count: 16 open.
    const members = Array.from({ length: 14 }, (_, i) => reg(`r${i + 1}`, i + 1, { absent: i >= 12 }));
    expect(monthlyPlacesOpen({ members, rows: [], maxPlayers: 16, seeded: false })).toBe(4);
  });

  it("not seeded: a PAYG player who named this date is counted in too; one already IN is not counted twice", () => {
    const members = [reg("a", 1), payg("p", { paygDated: true }), payg("q", { paygDated: true })];
    const rows = [row("q", "CONFIRMED", 5)];
    expect(monthlyPlacesOpen({ members, rows, maxPlayers: 5, seeded: false })).toBe(2);
  });

  it("not seeded: a regular who left the group, or already said OUT, frees the place", () => {
    const members = [reg("a", 1), reg("b", 2, { left: true }), reg("c", 3)];
    const rows = [row("c", "DROPPED", 3)];
    expect(monthlyPlacesOpen({ members, rows, maxPlayers: 3, seeded: false })).toBe(2);
  });

  it("never below zero", () => {
    const members = [reg("a", 1), reg("b", 2), reg("c", 3)];
    expect(monthlyPlacesOpen({ members, rows: [], maxPlayers: 2, seeded: false })).toBe(0);
  });
});

describe("guestFeePounds: what a pool or partner guest is told he pays", () => {
  it("a monthly week: the club's PAYG price, which is what he is charged after the game", () => {
    expect(guestFeePounds({ matchFee: null, activityFee: 7.5, feeSplitTotal: false, monthlyPaygPence: 800 })).toBe(8);
    expect(guestFeePounds({ matchFee: null, activityFee: null, feeSplitTotal: true, monthlyPaygPence: 750 })).toBe(7.5);
  });

  it("a fee already set on the match wins", () => {
    expect(guestFeePounds({ matchFee: 9, activityFee: null, feeSplitTotal: false, monthlyPaygPence: 800 })).toBe(9);
  });

  it("a weekly club, or a monthly week with no PAYG price: exactly as before", () => {
    expect(guestFeePounds({ matchFee: null, activityFee: 6, feeSplitTotal: false, monthlyPaygPence: null })).toBe(6);
    expect(guestFeePounds({ matchFee: null, activityFee: 6, feeSplitTotal: true, monthlyPaygPence: null })).toBeNull();
  });
});
