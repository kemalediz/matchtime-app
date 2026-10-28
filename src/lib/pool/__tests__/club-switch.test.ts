/**
 * A club's own player pool switch (2026-10-27; the club admins' since
 * 2026-10-28): writes `Organisation.featurePlayerPool`; OFF closes the
 * club's open pool asks at once through the pool's own close path
 * (`closePoolAsk(.., "switched-off")`); `poolAutoAsk` is never touched; the
 * first time it goes from off to on the admin team is told ONCE, ever: one
 * HQ post, or a DM to each owner and admin, claimed in the same transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Job = Record<string, unknown>;
const state = vi.hoisted(() => ({ claims: new Set<string>(), jobs: [] as Job[], flag: false, tx: null as unknown }));
const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  poolAsk: { findMany: vi.fn() },
  sentNotification: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../db", () => ({ db: dbMock }));
const roundMock = vi.hoisted(() => ({ closePoolAsk: vi.fn() }));
vi.mock("../round", () => roundMock);
const channel = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../../admin-channel", () => channel);

import { setClubPlayerPool } from "../club-switch";
import { poolClubSwitchCopy } from "../../i18n/pool-club-switch";

const NOON = new Date("2026-10-27T12:00:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  state.claims = new Set();
  state.jobs = [];
  state.flag = false;
  dbMock.organisation.findUnique.mockImplementation(async ({ select }) => (select?.language ? { name: "FNF", language: "tr" } : { id: "fnf", poolAutoAsk: false }));
  dbMock.organisation.update.mockImplementation(async ({ data }) => {
    state.flag = data.featurePlayerPool;
    return {};
  });
  dbMock.organisation.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.featurePlayerPool !== state.flag) return { count: 0 };
    state.flag = data.featurePlayerPool;
    return { count: 1 };
  });
  dbMock.poolAsk.findMany.mockResolvedValue([]);
  dbMock.sentNotification.findUnique.mockImplementation(async ({ where }) => (state.claims.has(where.key) ? { id: "x" } : null));
  // An interactive transaction: a throw inside rolls the claim back.
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const added: string[] = [];
    const tx = {
      sentNotification: {
        createMany: async ({ data }: { data: { key: string }[] }) => {
          if (state.claims.has(data[0].key)) return { count: 0 };
          state.claims.add(data[0].key);
          added.push(data[0].key);
          return { count: 1 };
        },
      },
      botJob: { create: async ({ data }: { data: Job }) => void state.jobs.push(data) },
    };
    state.tx = tx;
    try {
      return await fn(tx);
    } catch (err) {
      for (const k of added) state.claims.delete(k);
      throw err;
    }
  });
  roundMock.closePoolAsk.mockResolvedValue(true);
  channel.sendAdminNotice.mockResolvedValue({ channel: "admin-group", queued: 1 });
});

describe("setClubPlayerPool", () => {
  it("on writes the flag (compare-and-set) and closes nothing", async () => {
    expect(await setClubPlayerPool("fnf", true, NOON)).toEqual({ ok: true, on: true, closedAsks: 0, autoAsk: false, told: true });
    expect(dbMock.organisation.updateMany).toHaveBeenCalledWith({ where: { id: "fnf", featurePlayerPool: false }, data: { featurePlayerPool: true } });
    expect(roundMock.closePoolAsk).not.toHaveBeenCalled();
  });

  it("off writes the flag, then closes every open pool ask of the club as switched-off", async () => {
    dbMock.poolAsk.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    roundMock.closePoolAsk.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await setClubPlayerPool("fnf", false, NOON)).toEqual({ ok: true, on: false, closedAsks: 1, autoAsk: false, told: false });
    expect(dbMock.organisation.update).toHaveBeenCalledWith({ where: { id: "fnf" }, data: { featurePlayerPool: false } });
    expect(dbMock.poolAsk.findMany).toHaveBeenCalledWith({ where: { orgId: "fnf", status: "open" }, select: { id: true } });
    expect(roundMock.closePoolAsk).toHaveBeenCalledWith("a1", "switched-off", NOON);
    expect(roundMock.closePoolAsk).toHaveBeenCalledWith("a2", "switched-off", NOON);
    expect(dbMock.organisation.update.mock.invocationCallOrder[0]).toBeLessThan(dbMock.poolAsk.findMany.mock.invocationCallOrder[0]);
  });

  it("never writes poolAutoAsk", async () => {
    await setClubPlayerPool("fnf", true, NOON);
    await setClubPlayerPool("fnf", false, NOON);
    for (const [arg] of [...dbMock.organisation.update.mock.calls, ...dbMock.organisation.updateMany.mock.calls]) expect(Object.keys(arg.data)).toEqual(["featurePlayerPool"]);
  });

  it("an unknown club is refused and nothing is written", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(null);
    expect(await setClubPlayerPool("gone", true, NOON)).toEqual({ ok: false, reason: "not-found" });
    expect(dbMock.organisation.update).not.toHaveBeenCalled();
    expect(dbMock.organisation.updateMany).not.toHaveBeenCalled();
  });
});

describe("telling the admin team, once per club, ever, through the club's admin channel", () => {
  it("goes through sendAdminNotice in the claim's transaction, held through quiet hours, with its DM wording", async () => {
    await setClubPlayerPool("fnf", true, NOON);
    expect(channel.sendAdminNotice).toHaveBeenCalledTimes(1);
    const req = channel.sendAdminNotice.mock.calls[0][0];
    expect(req).toMatchObject({ orgId: "fnf", now: NOON, dmWording: true });
    expect(req.holdOvernight).not.toBe(false);
    expect(req.nextPath ?? null).toBeNull();
    expect(req.client).toBe(state.tx);
    expect(req.text("", "group")).toBe(poolClubSwitchCopy("tr").notice("FNF", "group"));
    expect(req.text("", "dm")).toBe(poolClubSwitchCopy("tr").notice("FNF", "dm"));
    expect([...state.claims]).toEqual(["org-fnf:pool-club-on"]);
  });

  it("off and on again never repeats it", async () => {
    await setClubPlayerPool("fnf", true, NOON);
    await setClubPlayerPool("fnf", false, NOON);
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ told: false });
    expect(channel.sendAdminNotice).toHaveBeenCalledTimes(1);
  });

  it("on while already on (a second tab) tells nobody", async () => {
    state.flag = true;
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ told: false });
    expect(channel.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("two switch-ons racing past the read: the claim lets only one through", async () => {
    dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
    await Promise.all([setClubPlayerPool("fnf", true, NOON), setClubPlayerPool("fnf", true, NOON)]);
    expect(channel.sendAdminNotice).toHaveBeenCalledTimes(1);
  });

  it("nobody to tell (the channel queued nothing): the claim is rolled back, so a later switch-on can still tell them", async () => {
    channel.sendAdminNotice.mockResolvedValue({ channel: "none", queued: 0 });
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ told: false });
    expect(state.claims.size).toBe(0);
  });

  it("a failure queuing the message never fails the switch", async () => {
    channel.sendAdminNotice.mockRejectedValue(new Error("db down"));
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ ok: true, on: true, told: false });
  });
});
