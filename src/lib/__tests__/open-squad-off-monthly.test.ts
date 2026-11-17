/**
 * SWITCHING THE OPEN SQUAD OFF BUMPS NOBODY, MONTHLY CLUBS INCLUDED
 * (review of #623, item 3).
 *
 * Sixteen regulars signed for November on a 7-a-side (14 places) while the
 * squad had no limit. Switched off mid-month: for the rest of November the
 * month's cap is max(14, 16) = 16, so next week's seed puts every regular
 * in, nobody on the bench, and no missed-game credit is earned for want of
 * a place; a pay-as-you-go player already in stays in. December's sign-up
 * has the format's 14 again.
 */
import { describe, expect, it } from "vitest";
import { decideMissedCredits, decideMonthlySeed, type WeekMember } from "../monthly-week-rules";
import { monthSeedCap, monthSignupCap } from "../open-squad";

const regular = (i: number): WeekMember => ({ userId: `r${i}`, name: `R${i}`, kind: "regular", slot: i + 1, paid: "claimed", absent: false, paygDated: false });
const SIXTEEN = Array.from({ length: 16 }, (_, i) => regular(i));

describe("the rest of the month after switching off", () => {
  it("the seed's cap: the format's places, or the regulars signed plus pay-as-you-go already in, whichever is more", () => {
    expect(monthSeedCap({ openSquad: false, places: 14, capFloor: 16, othersIn: 1 })).toBe(17);
    expect(monthSeedCap({ openSquad: false, places: 14, capFloor: null, othersIn: 1 })).toBe(14);
    expect(monthSeedCap({ openSquad: true, places: 14, capFloor: null, othersIn: 0 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("next week's seed: all sixteen regulars in, the PAYG player already in stays, nobody on the bench, nobody bumped", () => {
    const targetRows = [{ userId: "payg-zee", status: "CONFIRMED", position: 1 }];
    const cap = monthSeedCap({ openSquad: false, places: 14, capFloor: 16, othersIn: 1 });
    const seed = decideMonthlySeed({ members: SIXTEEN, targetRows, maxPlayers: cap });
    expect(seed.write.filter((w) => w.status === "CONFIRMED")).toHaveLength(16);
    expect(seed.write.filter((w) => w.status === "BENCH")).toEqual([]);
    expect(seed.bump).toEqual([]);
  });

  it("and no missed-game credit for any of them", () => {
    const cap = monthSeedCap({ openSquad: false, places: 14, capFloor: 16, othersIn: 0 });
    const seed = decideMonthlySeed({ members: SIXTEEN, targetRows: [], maxPlayers: cap });
    const rows = seed.write.map((w, i) => ({ userId: w.userId, name: "", status: w.status, position: i + 1 }));
    const credits = decideMissedCredits({ rule: "any-miss", members: SIXTEEN, rows, maxPlayers: 14, existing: [], creditedElsewhere: new Set() });
    expect(credits.create).toEqual([]);
  });

  it("the sign-up: this month keeps room for its sixteen; the next month has the format's places", () => {
    expect(monthSignupCap({ playersPerTeam: 7, openSquad: false, capFloor: 16 })).toBe(16);
    expect(monthSignupCap({ playersPerTeam: 7, openSquad: false, capFloor: null })).toBe(14);
    expect(monthSignupCap({ playersPerTeam: 7, openSquad: true, capFloor: null })).toBe(Number.POSITIVE_INFINITY);
  });
});
