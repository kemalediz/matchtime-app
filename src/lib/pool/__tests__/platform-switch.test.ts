/**
 * The player pool's platform switch (2026-10-28, decision log P.1): a
 * database row, read on every request and poll (never cached), the env var
 * only able to force it off. OFF closes every open pool ask at once; the
 * clubs' own flags are left as they are.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  poolAsk: { findMany: vi.fn() },
  organisation: { update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
const roundMock = vi.hoisted(() => ({ closePoolAsk: vi.fn() }));
vi.mock("../round", () => roundMock);
const headersMock = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => headersMock);

import { POOL_PLATFORM_KEY, loadPoolPlatformSwitch, poolPlatformOpenNow, setPoolPlatformSwitch } from "../platform-switch";
import { poolEnvForApiRequest, resolvePoolEnv } from "../switch-env";
import { isPoolOffersEnabled, poolSwitchUnread } from "../flags";

const NOW = new Date("2026-10-28T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.platformSetting.findUnique.mockResolvedValue({ on: true, updatedAt: NOW, updatedById: null });
  dbMock.platformSetting.upsert.mockResolvedValue({});
  dbMock.poolAsk.findMany.mockResolvedValue([]);
  roundMock.closePoolAsk.mockResolvedValue(true);
});

describe("reading the switch", () => {
  it("the row, on every call (no cache)", async () => {
    expect(await poolPlatformOpenNow({})).toBe(true);
    dbMock.platformSetting.findUnique.mockResolvedValue({ on: false, updatedAt: NOW, updatedById: "kemal" });
    expect(await poolPlatformOpenNow({})).toBe(false);
    expect(dbMock.platformSetting.findUnique).toHaveBeenCalledTimes(2);
    expect(dbMock.platformSetting.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: POOL_PLATFORM_KEY } }));
  });

  it("no row: off", async () => {
    dbMock.platformSetting.findUnique.mockResolvedValue(null);
    expect(await poolPlatformOpenNow({})).toBe(false);
  });

  it("POOL_OFFERS_ENABLED=0 forces it off; =1 (production today) changes nothing", async () => {
    expect(await poolPlatformOpenNow({ POOL_OFFERS_ENABLED: "0" })).toBe(false);
    expect(await poolPlatformOpenNow({ POOL_OFFERS_ENABLED: "1" })).toBe(true);
    expect(await loadPoolPlatformSwitch({ POOL_OFFERS_ENABLED: "off" })).toEqual({ on: true, forcedOff: true, updatedAt: NOW });
  });

  it("a database error: null (unread), never open", async () => {
    dbMock.platformSetting.findUnique.mockRejectedValue(new Error("down"));
    expect(await poolPlatformOpenNow({})).toBeNull();
  });
});

describe("resolving it for a request", () => {
  it("carries the row's answer in the call's env", async () => {
    expect(isPoolOffersEnabled(await resolvePoolEnv(undefined, {}))).toBe(true);
    dbMock.platformSetting.findUnique.mockResolvedValue({ on: false, updatedAt: NOW, updatedById: "kemal" });
    expect(isPoolOffersEnabled(await resolvePoolEnv(undefined, {}))).toBe(false);
  });

  it("unreadable: closed AND marked unread (so the sweep does not close every ask)", async () => {
    dbMock.platformSetting.findUnique.mockRejectedValue(new Error("down"));
    const env = await resolvePoolEnv(undefined, {});
    expect(isPoolOffersEnabled(env)).toBe(false);
    expect(poolSwitchUnread(env)).toBe(true);
  });

  it("the test seam wins only under MT_TEST_MODE=1, without reading the row", async () => {
    const req = (v: string) => new Request("http://x.test/api", { headers: { "x-mt-test-pool-open": v } });
    expect(isPoolOffersEnabled(await poolEnvForApiRequest(req("0"), { MT_TEST_MODE: "1" }))).toBe(false);
    expect(dbMock.platformSetting.findUnique).not.toHaveBeenCalled();
    dbMock.platformSetting.findUnique.mockResolvedValue(null);
    expect(isPoolOffersEnabled(await poolEnvForApiRequest(req("1"), { MT_TEST_MODE: "1" }))).toBe(true);
    expect(isPoolOffersEnabled(await poolEnvForApiRequest(req("1"), {}))).toBe(false);
  });
});

describe("setPoolPlatformSwitch", () => {
  it("on writes the row, by whom, and closes nothing", async () => {
    expect(await setPoolPlatformSwitch(true, "kemal", NOW, {})).toEqual({ on: true, closedAsks: 0, forcedOff: false });
    expect(dbMock.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: "pool-offers" },
      create: { key: "pool-offers", on: true, updatedById: "kemal" },
      update: { on: true, updatedById: "kemal" },
    });
    expect(roundMock.closePoolAsk).not.toHaveBeenCalled();
  });

  it("off writes the row FIRST, then closes every open ask of every club as switched-off", async () => {
    dbMock.poolAsk.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);
    roundMock.closePoolAsk.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await setPoolPlatformSwitch(false, "kemal", NOW, {})).toEqual({ on: false, closedAsks: 2, forcedOff: false });
    expect(dbMock.poolAsk.findMany).toHaveBeenCalledWith({ where: { status: "open" }, select: { id: true } });
    for (const id of ["a1", "a2", "a3"]) expect(roundMock.closePoolAsk).toHaveBeenCalledWith(id, "switched-off", NOW);
    expect(dbMock.platformSetting.upsert.mock.invocationCallOrder[0]).toBeLessThan(dbMock.poolAsk.findMany.mock.invocationCallOrder[0]);
  });

  it("never touches a club's own flags", async () => {
    await setPoolPlatformSwitch(false, "kemal", NOW, {});
    await setPoolPlatformSwitch(true, "kemal", NOW, {});
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });
});
