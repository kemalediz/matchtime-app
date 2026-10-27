/**
 * The platform owner's per-club player pool switch (2026-10-27): writes
 * `Organisation.featurePlayerPool`, and switched OFF it closes the club's
 * open pool asks at once through the pool's own close path
 * (`closePoolAsk(.., "switched-off")`, the sweep's own reason), so nothing
 * stays half open until the next sweep. `poolAutoAsk` is never touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), update: vi.fn() },
  poolAsk: { findMany: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
const roundMock = vi.hoisted(() => ({ closePoolAsk: vi.fn() }));
vi.mock("../round", () => roundMock);

import { setClubPlayerPool } from "../club-switch";

const NOW = new Date("2026-10-27T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue({ id: "fnf", poolAutoAsk: false });
  dbMock.organisation.update.mockResolvedValue({});
  dbMock.poolAsk.findMany.mockResolvedValue([]);
  roundMock.closePoolAsk.mockResolvedValue(true);
});

describe("setClubPlayerPool", () => {
  it("on writes the flag only, and closes nothing", async () => {
    expect(await setClubPlayerPool("fnf", true, NOW)).toEqual({ ok: true, on: true, closedAsks: 0, autoAsk: false });
    expect(dbMock.organisation.update).toHaveBeenCalledWith({ where: { id: "fnf" }, data: { featurePlayerPool: true } });
    expect(dbMock.poolAsk.findMany).not.toHaveBeenCalled();
    expect(roundMock.closePoolAsk).not.toHaveBeenCalled();
  });

  it("off writes the flag, then closes every open pool ask of the club as switched-off", async () => {
    dbMock.poolAsk.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    roundMock.closePoolAsk.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await setClubPlayerPool("fnf", false, NOW)).toEqual({ ok: true, on: false, closedAsks: 1, autoAsk: false });
    expect(dbMock.organisation.update).toHaveBeenCalledWith({ where: { id: "fnf" }, data: { featurePlayerPool: false } });
    expect(dbMock.poolAsk.findMany).toHaveBeenCalledWith({ where: { orgId: "fnf", status: "open" }, select: { id: true } });
    expect(roundMock.closePoolAsk).toHaveBeenCalledWith("a1", "switched-off", NOW);
    expect(roundMock.closePoolAsk).toHaveBeenCalledWith("a2", "switched-off", NOW);
    // The flag is written BEFORE the asks are closed, so no new ask can open between.
    expect(dbMock.organisation.update.mock.invocationCallOrder[0]).toBeLessThan(dbMock.poolAsk.findMany.mock.invocationCallOrder[0]);
  });

  it("says when the club's automatic asking was already on (left as it is)", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ id: "fnf", poolAutoAsk: true });
    expect(await setClubPlayerPool("fnf", true, NOW)).toEqual({ ok: true, on: true, closedAsks: 0, autoAsk: true });
  });

  it("never writes poolAutoAsk", async () => {
    await setClubPlayerPool("fnf", false, NOW);
    await setClubPlayerPool("fnf", true, NOW);
    for (const [arg] of dbMock.organisation.update.mock.calls) expect(Object.keys(arg.data)).toEqual(["featurePlayerPool"]);
  });

  it("an unknown club is refused and nothing is written", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await setClubPlayerPool("gone", true, NOW)).toEqual({ ok: false, reason: "not-found" });
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
  });
});
