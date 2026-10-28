/**
 * A platform switch that could not be read this poll (a database error,
 * `switch-env.ts`) is NOT the owner switching the pool off: nothing is sent,
 * and nothing is closed or cancelled. A real OFF still closes the club's
 * open asks at the next poll (decision L5a.11), exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  poolAsk: { findMany: vi.fn(), updateMany: vi.fn() },
  poolOffer: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../db", () => ({ db: dbMock }));
const dispatchMock = vi.hoisted(() => ({ stampUnreportedDeliveries: vi.fn(), POOL_OFFER_PURPOSE: "pool-offer" }));
vi.mock("../dispatch", async (orig) => ({ ...(await orig<typeof import("../dispatch")>()), ...dispatchMock }));

import { admitPoolOfferJobs } from "../dispatch";
import * as round from "../round";
import { POOL_SWITCH_UNREAD_KEY, poolSwitchEnv } from "../flags";

const NOW = new Date("2026-10-28T12:00:00Z");
const UNREAD = { ...poolSwitchEnv(false), [POOL_SWITCH_UNREAD_KEY]: "1" };
const ASK = { id: "a1", matchId: "m1", orgId: "fnf", roundId: null, places: 1, createdAt: NOW, org: { featurePlayerPool: true }, match: { date: NOW, status: "UPCOMING", isHistorical: false } };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.poolAsk.findMany.mockResolvedValue([ASK]);
  dbMock.poolAsk.updateMany.mockResolvedValue({ count: 1 });
  dbMock.poolOffer.findMany.mockResolvedValue([]);
});

describe("dispatch", () => {
  it("unread: every queued offer is held (skipped, not claimed, not cancelled)", async () => {
    const r = await admitPoolOfferJobs(["j1", "j2"], { now: NOW, limit: 5, env: UNREAD });
    expect([...r.skip]).toEqual(["j1", "j2"]);
    expect(r.claimed.size).toBe(0);
    expect(dbMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("the sweep", () => {
  it("unread: the open ask is left open", async () => {
    expect(await round.sweepPool(NOW, UNREAD)).toMatchObject({ closed: 0 });
    expect(dbMock.poolAsk.updateMany).not.toHaveBeenCalled();
  });

  it("really switched off: the open ask is closed as switched-off, as before", async () => {
    expect(await round.sweepPool(NOW, poolSwitchEnv(false))).toMatchObject({ closed: 1 });
    expect(dbMock.poolAsk.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1", status: "open" }, data: expect.objectContaining({ closeReason: "switched-off" }) }));
  });
});
