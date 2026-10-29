import { describe, expect, it } from "vitest";
import {
  CLUB_PAYG_FIRST_MINS,
  CLUB_PAYG_UNTOLD_MAX_MINS,
  clubFillsFirst,
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

const MIN = 60_000;

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

describe("clubFillsFirst: the automatic ask waits while the club's own players have their chance", () => {
  const now = new Date("2026-11-09T15:00:00Z");
  const base = {
    monthly: true,
    seeded: true,
    pickMode: "first-come" as string | null,
    benchCount: 0,
    paygPoolSize: 3,
    newestOpenOfferAt: new Date(now.getTime() - 3 * 60 * MIN),
    clubToldAt: new Date(now.getTime() - 2 * 60 * MIN),
    now,
  };

  it("a weekly club (no monthly week): never held, exactly as before", () => {
    expect(clubFillsFirst({ ...base, monthly: false, benchCount: 0, newestOpenOfferAt: null, clubToldAt: null })).toBe(false);
  });

  it("the club's PAYG players were told over an hour ago: the pool and partners may be asked", () => {
    expect(clubFillsFirst(base)).toBe(false);
  });

  it("the place opened and the PAYG players were told only now: held for the club's hour", () => {
    const told = new Date(now.getTime() - 10 * MIN);
    expect(clubFillsFirst({ ...base, newestOpenOfferAt: new Date(now.getTime() - 11 * MIN), clubToldAt: told })).toBe(true);
    expect(clubFillsFirst({ ...base, newestOpenOfferAt: told, clubToldAt: told, now: new Date(told.getTime() + CLUB_PAYG_FIRST_MINS * MIN) })).toBe(false);
  });

  it("an open place with no offer yet (the sweep opens it on this poll): held", () => {
    expect(clubFillsFirst({ ...base, newestOpenOfferAt: null, clubToldAt: null })).toBe(true);
  });

  it("a newer place than the last time the club was told: held until it is told", () => {
    expect(clubFillsFirst({ ...base, newestOpenOfferAt: new Date(now.getTime() - 20 * MIN), clubToldAt: new Date(now.getTime() - 90 * MIN) })).toBe(true);
  });

  it("never told (quiet hours, a lost send): held at most two hours from the offer, then the pool and partners are asked", () => {
    const opened = new Date(now.getTime() - (CLUB_PAYG_UNTOLD_MAX_MINS - 1) * MIN);
    expect(clubFillsFirst({ ...base, newestOpenOfferAt: opened, clubToldAt: null })).toBe(true);
    expect(clubFillsFirst({ ...base, newestOpenOfferAt: new Date(now.getTime() - CLUB_PAYG_UNTOLD_MAX_MINS * MIN), clubToldAt: null })).toBe(false);
  });

  it("nobody in the club's PAYG pool, or an organiser-pick club (its admins pick): nothing of the club's to wait for", () => {
    const fresh = { newestOpenOfferAt: new Date(now.getTime() - MIN), clubToldAt: new Date(now.getTime() - MIN) };
    expect(clubFillsFirst({ ...base, ...fresh, paygPoolSize: 0 })).toBe(false);
    expect(clubFillsFirst({ ...base, ...fresh, pickMode: "organiser" })).toBe(false);
  });

  it("the week not seeded yet (the poll's sweep seeds it after the automatic ask runs): held, whatever else", () => {
    expect(clubFillsFirst({ ...base, seeded: false, paygPoolSize: 0, pickMode: "organiser" })).toBe(true);
  });

  it("somebody on the club's bench: held (the bench offer runs first)", () => {
    expect(clubFillsFirst({ ...base, benchCount: 1 })).toBe(true);
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
