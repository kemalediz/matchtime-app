/**
 * OPEN SQUAD IN THE WRITE (2026-11-17, the Vets: no squad limit, no bench).
 *
 * `registerAttendance` decides with the same rule the engine's react uses
 * (`canTakeFreePlace`), so every IN is CONFIRMED whatever the count, and a
 * bench request is an IN. Every IN path (a player's own, an admin's add,
 * the friend link, /play, a guest card, the monthly paste) writes through
 * here, so this is where "never the bench, never full" holds for all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    maxPlayers: 14,
    pickMode: "first-come" as string,
    openSquad: true as boolean,
    rows: [] as { id: string; matchId: string; userId: string; status: string; position: number; benchByChoice?: boolean }[],
    roles: {} as Record<string, string>,
    queries: [] as string[],
    events: [] as Array<{ userId: string; fromStatus: string | null; toStatus: string; note?: string | null }>,
  },
}));

vi.mock("../db", () => {
  const s = () => h.state;
  const db: Record<string, unknown> = {
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return {
    db: Object.assign(db, {
      match: {
        findUnique: async () => ({
          id: "m1",
          maxPlayers: s().maxPlayers,
          date: new Date(Date.now() + 3 * 86400_000),
          attendanceDeadline: new Date(Date.now() + 2 * 86400_000),
          activity: { orgId: "org1", name: "Football 7-a-side", org: { benchPickMode: s().pickMode, openSquad: s().openSquad } },
        }),
        findFirst: async () => null,
      },
      membership: {
        findUnique: async ({ where }: { where: { userId_orgId: { userId: string } } }) => {
          s().queries.push("membership.findUnique");
          const role = s().roles[where.userId_orgId.userId];
          return role ? { role, leftAt: null } : { role: "PLAYER", leftAt: null };
        },
      },
      attendance: {
        findUnique: async ({ where }: { where: { matchId_userId: { userId: string } } }) =>
          s().rows.find((r) => r.userId === where.matchId_userId.userId) ?? null,
        findMany: async () => [...s().rows].sort((a, b) => a.position - b.position),
        aggregate: async () => ({ _max: { position: s().rows.reduce((m, r) => Math.max(m, r.position), 0) } }),
        count: async ({ where }: { where: { status: string } }) => s().rows.filter((r) => r.status === where.status).length,
        upsert: async ({ where, create, update }: { where: { matchId_userId: { userId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const found = s().rows.find((r) => r.userId === where.matchId_userId.userId);
          if (found) return Object.assign(found, update);
          const row = { id: `a-${s().rows.length + 1}`, ...(create as { matchId: string; userId: string; status: string; position: number }) };
          s().rows.push(row);
          return row;
        },
        updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: { status: string } }) => {
          const r = s().rows.find((x) => x.id === where.id && (!where.status || x.status === where.status));
          if (!r) return { count: 0 };
          r.status = data.status;
          return { count: 1 };
        },
      },
      benchSlotOffer: {
        count: async () => {
          s().queries.push("benchSlotOffer.count");
          return 0;
        },
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => null,
      },
      guestPlace: { updateMany: async () => ({ count: 0 }) },
      sentNotification: { deleteMany: async () => ({ count: 0 }) },
      attendanceEvent: {
        create: async ({ data }: { data: { userId: string; fromStatus: string | null; toStatus: string; note?: string } }) => {
          s().events.push(data);
          return {};
        },
        findMany: async () => [],
      },
      user: { findUnique: async () => ({ name: "X" }) },
    }),
  };
});
const requestBench = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../bot-scheduler", () => ({
  requestBenchConfirmationOnDrop: requestBench,
  queueSlotEmojiRefresh: vi.fn(async () => {}),
}));
vi.mock("../squad-announce", () => ({ announceSquadFullIfJustFilled: vi.fn(async () => {}) }));
vi.mock("../admin-channel", () => ({ sendAdminNotice: vi.fn(async () => ({ channel: "dm", queued: 1 })) }));

import { registerAttendance, cancelAttendance } from "../attendance";

const self = (userId: string) => ({ event: { cause: "self-attendance", actorKind: "player", actorUserId: userId } as const });

function seed(confirmed: number, extra: Array<{ userId: string; status: string }> = []) {
  h.state.rows = Array.from({ length: confirmed }, (_, i) => ({ id: `a-${i + 1}`, matchId: "m1", userId: `p${i + 1}`, status: "CONFIRMED", position: i + 1 }));
  for (const e of extra) h.state.rows.push({ id: `a-${h.state.rows.length + 1}`, matchId: "m1", position: h.state.rows.length + 1, ...e });
}

beforeEach(() => {
  h.state.maxPlayers = 14;
  h.state.pickMode = "first-come";
  h.state.openSquad = true;
  h.state.rows = [];
  h.state.roles = {};
  h.state.queries = [];
  h.state.events = [];
  requestBench.mockClear();
});

describe("registerAttendance in an open squad (no limit, no bench)", () => {
  it("an IN past the format's places is CONFIRMED (the 15th, the 20th)", async () => {
    seed(14);
    expect((await registerAttendance("zeeshan", "m1", self("zeeshan"))).status).toBe("CONFIRMED");
    seed(19);
    expect((await registerAttendance("ali", "m1", self("ali"))).status).toBe("CONFIRMED");
  });

  it("an explicit bench request is an IN: there is no bench", async () => {
    seed(14);
    const res = await registerAttendance("zeeshan", "m1", { ...self("zeeshan"), benchIntent: "explicit" });
    expect(res.status).toBe("CONFIRMED");
    expect(h.state.rows.find((r) => r.userId === "zeeshan")).toMatchObject({ status: "CONFIRMED", benchByChoice: false });
  });

  it("a player in the squad asking for the bench stays in", async () => {
    seed(14);
    expect((await registerAttendance("p2", "m1", { ...self("p2"), benchIntent: "explicit" })).status).toBe("CONFIRMED");
    expect(h.state.rows.find((r) => r.userId === "p2")?.status).toBe("CONFIRMED");
  });

  it("an organiser-pick club with the setting on still takes every IN, with no admin lookup", async () => {
    h.state.pickMode = "organiser";
    seed(3);
    expect((await registerAttendance("wasim", "m1", self("wasim"))).status).toBe("CONFIRMED");
    expect(h.state.queries).not.toContain("membership.findUnique");
  });

  it("a player left on the bench from before the switch moves up on his own IN", async () => {
    seed(14, [{ userId: "recai", status: "BENCH" }]);
    expect((await registerAttendance("recai", "m1", { ...self("recai"), promoteFromBench: true })).status).toBe("CONFIRMED");
  });

  it("an OUT shrinks the squad", async () => {
    seed(15);
    await cancelAttendance("p3", "m1", self("p3").event);
    expect(h.state.rows.find((r) => r.userId === "p3")?.status).toBe("DROPPED");
    expect(h.state.rows.filter((r) => r.status === "CONFIRMED")).toHaveLength(14);
  });

  it("off: a 15th IN goes on the bench, exactly as before", async () => {
    h.state.openSquad = false;
    seed(14);
    expect((await registerAttendance("zeeshan", "m1", self("zeeshan"))).status).toBe("BENCH");
  });
});
