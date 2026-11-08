/**
 * The adapter (`monthly-week-asks.ts`): a weekly club's answers are exactly
 * the old count with one small read; a monthly week's come from the week.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn() },
  attendance: { count: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const weekMock = vi.hoisted(() => ({ loadMonthlyWeek: vi.fn() }));
vi.mock("../monthly-week", () => weekMock);

import { askPlacesOpen, guestPaygPence } from "../monthly-week-asks";

const reg = (userId: string, slot: number) => ({ userId, name: userId, kind: "regular", slot, paid: "confirmed", absent: false, paygDated: false });
const WEEK = {
  matchId: "m1",
  orgId: "vets",
  seeded: true,
  maxPlayers: 4,
  paygPricePence: 800,
  pickMode: "first-come",
  members: [reg("a", 1), reg("b", 2), reg("c", 3)],
  rows: [
    { userId: "a", name: "a", status: "CONFIRMED", position: 1 },
    { userId: "b", name: "b", status: "CONFIRMED", position: 2 },
    { userId: "c", name: "c", status: "DROPPED", position: 3 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findUnique.mockResolvedValue({ maxPlayers: 14, activity: { org: { squadMode: "monthly" } } });
  dbMock.attendance.count.mockResolvedValue(10);
  weekMock.loadMonthlyWeek.mockResolvedValue(WEEK);
});

describe("a weekly club", () => {
  beforeEach(() => dbMock.match.findUnique.mockResolvedValue({ maxPlayers: 14, activity: { org: { squadMode: "weekly" } } }));

  it("places open: its size less its CONFIRMED rows; the month is never read", async () => {
    expect(await askPlacesOpen("m1")).toBe(4);
    expect(weekMock.loadMonthlyWeek).not.toHaveBeenCalled();
  });

  it("no PAYG price", async () => {
    expect(await guestPaygPence("m1")).toBeNull();
  });

  it("no such match: nothing open", async () => {
    dbMock.match.findUnique.mockResolvedValue(null);
    expect(await askPlacesOpen("gone")).toBe(0);
  });
});

describe("a monthly week", () => {
  it("places open: the week's own count", async () => {
    expect(await askPlacesOpen("m1")).toBe(2);
    expect(dbMock.attendance.count).not.toHaveBeenCalled();
  });

  it("a monthly club's match with no running month: the plain count", async () => {
    weekMock.loadMonthlyWeek.mockResolvedValue(null);
    expect(await askPlacesOpen("m1")).toBe(4);
    expect(await guestPaygPence("m1")).toBeNull();
  });

  it("the PAYG price", async () => {
    expect(await guestPaygPence("m1")).toBe(800);
  });
});
