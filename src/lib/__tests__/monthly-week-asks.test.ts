/**
 * The adapter (`monthly-week-asks.ts`): a weekly club's answers are exactly
 * the old count with one small read; a monthly week's come from the week.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn() },
  attendance: { count: vi.fn() },
  benchSlotOffer: { findFirst: vi.fn() },
  sentNotification: { findFirst: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
const weekMock = vi.hoisted(() => ({ loadMonthlyWeek: vi.fn(), loadPaygPool: vi.fn() }));
vi.mock("../monthly-week", () => ({ ...weekMock, weekListKeyPrefix: (id: string) => `${id}:month-list:` }));

import { askPlacesOpen, clubFillsFirstFor, guestPaygPence } from "../monthly-week-asks";

const NOW = new Date("2026-11-09T14:00:00Z");
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
  weekMock.loadPaygPool.mockResolvedValue([{ userId: "p" }]);
  dbMock.benchSlotOffer.findFirst.mockResolvedValue({ createdAt: new Date(NOW.getTime() - 30 * 60_000) });
  dbMock.sentNotification.findFirst.mockResolvedValue({ createdAt: new Date(NOW.getTime() - 20 * 60_000) });
});

describe("a weekly club", () => {
  beforeEach(() => dbMock.match.findUnique.mockResolvedValue({ maxPlayers: 14, activity: { org: { squadMode: "weekly" } } }));

  it("places open: its size less its CONFIRMED rows; the month is never read", async () => {
    expect(await askPlacesOpen("m1")).toBe(4);
    expect(weekMock.loadMonthlyWeek).not.toHaveBeenCalled();
  });

  it("no PAYG price, and never held", async () => {
    expect(await guestPaygPence("m1")).toBeNull();
    expect(await clubFillsFirstFor("m1", NOW)).toBe(false);
    expect(dbMock.benchSlotOffer.findFirst).not.toHaveBeenCalled();
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

  it("the club's PAYG players were told 20 minutes ago: held; told 70 minutes ago: not", async () => {
    expect(await clubFillsFirstFor("m1", NOW)).toBe(true);
    dbMock.benchSlotOffer.findFirst.mockResolvedValue({ createdAt: new Date(NOW.getTime() - 80 * 60_000) });
    dbMock.sentNotification.findFirst.mockResolvedValue({ createdAt: new Date(NOW.getTime() - 70 * 60_000) });
    expect(await clubFillsFirstFor("m1", NOW)).toBe(false);
    expect(dbMock.sentNotification.findFirst.mock.calls[0][0].where).toEqual({
      matchId: "m1",
      OR: [{ key: { startsWith: "m1:payg-pool-" } }, { key: { startsWith: "m1:month-list:" } }],
    });
  });

  it("an empty PAYG pool: nothing to wait for", async () => {
    weekMock.loadPaygPool.mockResolvedValue([]);
    expect(await clubFillsFirstFor("m1", NOW)).toBe(false);
  });
});
