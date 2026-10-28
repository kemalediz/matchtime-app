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
const state = vi.hoisted(() => ({ claims: new Set<string>(), jobs: [] as Job[], flag: false }));
const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  poolAsk: { findMany: vi.fn() },
  sentNotification: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../db", () => ({ db: dbMock }));
const roundMock = vi.hoisted(() => ({ closePoolAsk: vi.fn() }));
vi.mock("../round", () => roundMock);
const channel = vi.hoisted(() => ({ loadAdminChannel: vi.fn() }));
vi.mock("../../admin-channel", () => channel);

import { setClubPlayerPool } from "../club-switch";
import { poolClubSwitchCopy } from "../../i18n/pool-club-switch";

const NOON = new Date("2026-10-27T12:00:00Z");
const NIGHT = new Date("2026-10-27T23:30:00Z");
const ADMINS = [
  { id: "own", name: "Erdal", role: "OWNER", phoneNumber: "+447700900001" },
  { id: "adm", name: "Ali", role: "ADMIN", phoneNumber: "447700900002" },
  { id: "nop", name: "No phone", role: "ADMIN", phoneNumber: null },
];
const QUIET = { enabled: true, from: "23:00", to: "09:00" };
const hq = (over: Record<string, unknown> = {}) => ({
  orgId: "fnf",
  orgName: "FNF",
  language: "tr",
  cfg: { mode: "admin-group", channelUserId: null, adminGroupId: "hq@g.us" },
  admins: ADMINS,
  adminGroupPostable: true,
  quietHours: QUIET,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.claims = new Set();
  state.jobs = [];
  state.flag = false;
  dbMock.organisation.findUnique.mockResolvedValue({ id: "fnf", poolAutoAsk: false });
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
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      sentNotification: {
        createMany: async ({ data }: { data: { key: string }[] }) => {
          if (state.claims.has(data[0].key)) return { count: 0 };
          state.claims.add(data[0].key);
          return { count: 1 };
        },
      },
      botJob: { create: async ({ data }: { data: Job }) => void state.jobs.push(data) },
    }),
  );
  roundMock.closePoolAsk.mockResolvedValue(true);
  channel.loadAdminChannel.mockResolvedValue(hq());
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

describe("telling the admin team, once per club, ever", () => {
  it("a club with HQ: ONE admin-group post, in the club's language, never the players' group", async () => {
    await setClubPlayerPool("fnf", true, NOON);
    expect(state.jobs).toEqual([{ orgId: "fnf", kind: "admin-group", text: poolClubSwitchCopy("tr").notice("FNF", "group") }]);
    expect([...state.claims]).toEqual(["org-fnf:pool-club-on"]);
  });

  it("no HQ: a DM to each owner and admin with a phone, the DM wording", async () => {
    channel.loadAdminChannel.mockResolvedValue(hq({ language: "en", cfg: { mode: "each-admin", channelUserId: null, adminGroupId: null } }));
    await setClubPlayerPool("fnf", true, NOON);
    const text = poolClubSwitchCopy("en").notice("FNF", "dm");
    expect(state.jobs).toEqual([
      { orgId: "fnf", kind: "dm", phone: "447700900001", text },
      { orgId: "fnf", kind: "dm", phone: "447700900002", text },
    ]);
  });

  it("an HQ MatchTime cannot post in counts as none", async () => {
    channel.loadAdminChannel.mockResolvedValue(hq({ adminGroupPostable: false }));
    await setClubPlayerPool("fnf", true, NOON);
    expect(state.jobs.map((j) => j.kind)).toEqual(["dm", "dm"]);
  });

  it("inside the club's quiet hours it waits until they end", async () => {
    await setClubPlayerPool("fnf", true, NIGHT);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0].sendAfter).toEqual(new Date("2026-10-28T09:00:00Z"));
  });

  it("off and on again never repeats it", async () => {
    await setClubPlayerPool("fnf", true, NOON);
    await setClubPlayerPool("fnf", false, NOON);
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ told: false });
    expect(state.jobs).toHaveLength(1);
  });

  it("on while already on (a second tab) tells nobody", async () => {
    state.flag = true;
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ told: false });
    expect(state.jobs).toEqual([]);
    expect(channel.loadAdminChannel).not.toHaveBeenCalled();
  });

  it("two switch-ons racing past the read: the claim lets only one through", async () => {
    // Both see no claim, both reach the transaction.
    dbMock.organisation.updateMany.mockResolvedValue({ count: 1 });
    await Promise.all([setClubPlayerPool("fnf", true, NOON), setClubPlayerPool("fnf", true, NOON)]);
    expect(state.jobs).toHaveLength(1);
  });

  it("nobody to tell: nothing claimed, so a later switch-on can still tell them", async () => {
    channel.loadAdminChannel.mockResolvedValue(hq({ cfg: { mode: "each-admin", channelUserId: null, adminGroupId: null }, admins: [ADMINS[2]] }));
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ told: false });
    expect(state.claims.size).toBe(0);
  });

  it("a failure queuing the message never fails the switch", async () => {
    channel.loadAdminChannel.mockRejectedValue(new Error("db down"));
    expect(await setClubPlayerPool("fnf", true, NOON)).toMatchObject({ ok: true, on: true, told: false });
  });
});
