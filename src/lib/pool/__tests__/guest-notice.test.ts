/**
 * A pool guest joining or leaving a game is told where the whole club can
 * see it (Kemal, 2026-10-29), by the shared route (`clubNoticeRoute`):
 * HQ through the admin channel as before; a club whose only group is its
 * players' group gets ONE post there and no admin DM; no postable group,
 * the admin channel's DMs. Each notice is claimed once, with its job, in
 * one transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Job = Record<string, unknown>;
const state = vi.hoisted(() => ({ claims: new Set<string>(), kinds: [] as string[], jobs: [] as Job[], org: null as Record<string, unknown> | null, postable: true }));
const dbMock = vi.hoisted(() => ({ organisation: { findUnique: vi.fn() }, $transaction: vi.fn() }));
vi.mock("../../db", () => ({ db: dbMock }));
const channel = vi.hoisted(() => ({ sendAdminNotice: vi.fn() }));
vi.mock("../../admin-channel", () => channel);
vi.mock("../../group-postability-store", () => ({ isGroupPostable: async () => state.postable }));

import { tellClubAboutPoolGuest } from "../guest-notice";
import { tellClubAboutGuest } from "../../guest-notice";

const NOON = new Date("2026-10-29T12:00:00Z");
const NIGHT = new Date("2026-10-29T23:30:00Z");
const ARGS = { orgId: "fnf", matchId: "m1", key: "pool-offer:o1:placed", hqText: "HQ words. Turned up to 3 of 4 MatchTime games.", groupText: "Group words." };

beforeEach(() => {
  vi.clearAllMocks();
  state.claims = new Set();
  state.kinds = [];
  state.jobs = [];
  state.postable = true;
  state.org = { adminGroupId: null, whatsappGroupId: "fnf@g.us", whatsappBotEnabled: true, quietHoursEnabled: true, quietHoursFrom: "23:00", quietHoursTo: "09:00" };
  dbMock.organisation.findUnique.mockImplementation(async () => state.org);
  dbMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const added: string[] = [];
    const tx = {
      sentNotification: {
        createMany: async ({ data }: { data: { key: string; kind: string }[] }) => {
          if (state.claims.has(data[0].key)) return { count: 0 };
          state.kinds.push(data[0].kind);
          state.claims.add(data[0].key);
          added.push(data[0].key);
          return { count: 1 };
        },
      },
      botJob: { create: async ({ data }: { data: Job }) => (state.jobs.push(data), data) },
    };
    try {
      return await fn(tx);
    } catch (err) {
      for (const k of added) state.claims.delete(k);
      throw err;
    }
  });
  channel.sendAdminNotice.mockImplementation(async (req: { client: { botJob: { create: (a: { data: Job }) => Promise<unknown> } }; text: string }) => {
    await req.client.botJob.create({ data: { kind: "admin-group", text: req.text } });
    return { channel: "admin-group", queued: 1 };
  });
});

describe("tellClubAboutPoolGuest", () => {
  it("a club with HQ: the admin channel, with the HQ words (turn-up line kept), nothing in the players' group", async () => {
    state.org = { ...state.org, adminGroupId: "hq@g.us" };
    expect(await tellClubAboutPoolGuest({ ...ARGS, now: NOON })).toBe("admin-channel");
    expect(channel.sendAdminNotice).toHaveBeenCalledTimes(1);
    expect(channel.sendAdminNotice.mock.calls[0][0]).toMatchObject({ orgId: "fnf", holdOvernight: false, text: ARGS.hqText });
    expect(state.jobs.filter((j) => j.kind === "group")).toEqual([]);
  });

  it("a club with only its players' group: ONE group post with the group words, and no admin notice at all", async () => {
    expect(await tellClubAboutPoolGuest({ ...ARGS, now: NOON })).toBe("players-group");
    expect(state.jobs).toEqual([{ orgId: "fnf", kind: "group", text: "Group words.", matchId: "m1" }]);
    expect(channel.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("the players' group post waits for the club's quiet hours to end", async () => {
    await tellClubAboutPoolGuest({ ...ARGS, now: NIGHT });
    expect(state.jobs).toHaveLength(1);
    expect((state.jobs[0].sendAfter as Date).toISOString()).toBe("2026-10-30T09:00:00.000Z");
  });

  it("no postable group (not postable, muted, or none): the admin channel's DMs", async () => {
    const base = { ...state.org };
    const cases = [
      { org: base, postable: false },
      { org: { ...base, whatsappBotEnabled: false }, postable: true },
      { org: { ...base, whatsappGroupId: null }, postable: true },
    ];
    for (const c of cases) {
      channel.sendAdminNotice.mockClear();
      state.claims = new Set();
      state.org = c.org;
      state.postable = c.postable;
      expect(await tellClubAboutPoolGuest({ ...ARGS, now: NOON })).toBe("admin-channel");
      expect(channel.sendAdminNotice).toHaveBeenCalledTimes(1);
    }
  });

  it("told once: the same key twice queues nothing more, on either route", async () => {
    await tellClubAboutPoolGuest({ ...ARGS, now: NOON });
    expect(await tellClubAboutPoolGuest({ ...ARGS, now: NOON })).toBe("told-already");
    expect(state.jobs).toHaveLength(1);
    state.org = { ...state.org, adminGroupId: "hq@g.us" };
    expect(await tellClubAboutPoolGuest({ ...ARGS, now: NOON })).toBe("told-already");
    expect(channel.sendAdminNotice).not.toHaveBeenCalled();
  });

  it("a club that is gone: nothing", async () => {
    state.org = null;
    expect(await tellClubAboutPoolGuest({ ...ARGS, now: NOON })).toBe("none");
    expect(state.jobs).toEqual([]);
  });
});

describe("tellClubAboutGuest (shared with partner club guests, 2026-10-29)", () => {
  it("the pool claims with its own kind; a partner guest's notice with the caller's kind, by the same route", async () => {
    await tellClubAboutPoolGuest({ ...ARGS, now: NOON });
    expect(await tellClubAboutGuest({ ...ARGS, key: "xask:ask1:vol:ali:in:wa-1", kind: "xask-volunteer", now: NOON })).toBe("players-group");
    expect(state.kinds).toEqual(["pool-guest", "xask-volunteer"]);
    expect(state.jobs.map((j) => j.kind)).toEqual(["group", "group"]);
    expect(channel.sendAdminNotice).not.toHaveBeenCalled();
  });
});
