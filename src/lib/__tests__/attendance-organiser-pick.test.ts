/**
 * ORGANISER PICK IN THE WRITE (slice 2b, 2026-10-01, plan 2.6).
 *
 * `registerAttendance` decides CONFIRMED or BENCH with the same rule the
 * engine's react uses (`canTakeFreePlace`), so the ✅ or 🪑 on the message
 * and the row can never disagree. In an organiser-pick club only an admin,
 * a reclaim or a running fallback offer takes a free place; a first-come
 * club (Sutton FC) is today's arithmetic and makes no new query. A drop in
 * an organiser club opens no bench offer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    maxPlayers: 4,
    pickMode: "organiser" as string | undefined,
    rows: [] as { id: string; matchId: string; userId: string; status: string; position: number }[],
    roles: {} as Record<string, string>,
    openOffers: 0,
    events: [] as Array<{ userId: string; fromStatus: string | null; toStatus: string; note?: string | null }>,
    queries: [] as string[],
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
          activity: { orgId: "org1", name: "Friday 9-a-side", org: s().pickMode ? { benchPickMode: s().pickMode } : undefined },
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
        update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
          const r = s().rows.find((x) => x.id === where.id)!;
          r.status = data.status;
          return r;
        },
      },
      benchSlotOffer: {
        count: async () => {
          s().queries.push("benchSlotOffer.count");
          return s().openOffers;
        },
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => null,
      },
      sentNotification: { deleteMany: async () => ({ count: 0 }) },
      attendanceEvent: {
        create: async ({ data }: { data: { userId: string; fromStatus: string | null; toStatus: string; note?: string } }) => {
          s().events.push(data);
          return {};
        },
        findMany: async ({ where }: { where: { userId: { in: string[] } } }) => {
          s().queries.push("attendanceEvent.findMany");
          return [...s().events].reverse().filter((e) => where.userId.in.includes(e.userId) && e.toStatus === "DROPPED");
        },
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
  h.state.maxPlayers = 4;
  h.state.pickMode = "organiser";
  h.state.rows = [];
  h.state.roles = { hamzah: "OWNER", raihan: "ADMIN" };
  h.state.openOffers = 0;
  h.state.events = [];
  h.state.queries = [];
  requestBench.mockClear();
});

describe("registerAttendance in an organiser-pick club", () => {
  it("a non-admin IN with a place open goes on the waiting list, noted", async () => {
    seed(3);
    const res = await registerAttendance("wasim", "m1", self("wasim"));
    expect(res.status).toBe("BENCH");
    expect(h.state.events.at(-1)).toMatchObject({ userId: "wasim", toStatus: "BENCH", note: "organiser picks who plays" });
  });

  it("an admin's own IN takes the place (looked up from the membership)", async () => {
    seed(3);
    expect((await registerAttendance("raihan", "m1", self("raihan"))).status).toBe("CONFIRMED");
  });

  it("the engine's own decision on admin standing is used when given", async () => {
    seed(3);
    const res = await registerAttendance("wasim", "m1", { ...self("wasim"), actorIsAdmin: true });
    expect(res.status).toBe("CONFIRMED");
    expect(h.state.queries).not.toContain("membership.findUnique");
  });

  it("an admin instruction for someone else takes the place", async () => {
    seed(3);
    const res = await registerAttendance("wasim", "m1", {
      event: { cause: "admin-message", actorKind: "admin", actorUserId: "hamzah" },
    });
    expect(res.status).toBe("CONFIRMED");
  });

  it("a reclaim: CONFIRMED, OUT, then IN again while the place is free", async () => {
    seed(3, [{ userId: "wasim", status: "DROPPED" }]);
    h.state.events.push({ userId: "wasim", fromStatus: "CONFIRMED", toStatus: "DROPPED" });
    expect((await registerAttendance("wasim", "m1", self("wasim"))).status).toBe("CONFIRMED");
  });

  it("dropped off the bench is not a reclaim", async () => {
    seed(3, [{ userId: "wasim", status: "DROPPED" }]);
    h.state.events.push({ userId: "wasim", fromStatus: "BENCH", toStatus: "DROPPED" });
    expect((await registerAttendance("wasim", "m1", self("wasim"))).status).toBe("BENCH");
  });

  it("while the fallback offer runs, a bench player's own IN is promoted", async () => {
    seed(3, [{ userId: "wasim", status: "BENCH" }]);
    h.state.openOffers = 1;
    expect((await registerAttendance("wasim", "m1", { ...self("wasim"), promoteFromBench: true })).status).toBe("CONFIRMED");
  });

  it("with no offer, a bench player's own IN is not promoted", async () => {
    seed(3, [{ userId: "wasim", status: "BENCH" }]);
    expect((await registerAttendance("wasim", "m1", { ...self("wasim"), promoteFromBench: true })).status).toBe("BENCH");
  });

  it("full is BENCH for everyone, the ordinary note", async () => {
    seed(4);
    const res = await registerAttendance("raihan", "m1", self("raihan"));
    expect(res.status).toBe("BENCH");
    expect(h.state.events.at(-1)?.note).toMatch(/squad full/);
  });
});

describe("a first-come club (Sutton FC) is today's rule, with no new query", () => {
  it("a non-admin IN with a place open is CONFIRMED", async () => {
    h.state.pickMode = undefined;
    seed(3);
    expect((await registerAttendance("wasim", "m1", self("wasim"))).status).toBe("CONFIRMED");
    expect(h.state.queries).toEqual([]);
  });
});

describe("a drop", () => {
  it("asks the bench scheduler as ever (it decides; organiser clubs return there)", async () => {
    seed(4);
    await cancelAttendance("p1", "m1", { cause: "self-attendance", actorKind: "player", actorUserId: "p1" });
    expect(requestBench).toHaveBeenCalledWith("m1", "p1");
  });
});
