/**
 * Every attendance write in `lib/attendance.ts` leaves an event, and it
 * leaves it INSIDE the transaction that made the change.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE TRANSACTION IS THE POINT
 * ─────────────────────────────────────────────────────────────────────
 * A log written NEXT TO the write can disagree with the state: the row
 * lands, the process dies, the event never happens, and the log now
 * quietly says a player is on the bench who is actually in the squad.
 * Something that can disagree with the state is not evidence, and this
 * log exists to be evidence for §10 step 6 — the change that can put a
 * player at a pitch with no slot.
 *
 * So the fake `db` here refuses to record an event unless it was handed
 * the transaction client. A regression that moves the write back out of
 * the transaction fails this file rather than being discovered months
 * later by a replay that cannot be trusted.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE CAUSE IS ASSERTED, NOT JUST THE COUNT
 * ─────────────────────────────────────────────────────────────────────
 * A drop caused by a bench claim and a player's own OUT leave an
 * identical row behind. The replay has to tell them apart, so "an event
 * exists" is not the assertion — "the right event exists" is.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    maxPlayers: 3,
    rows: [] as {
      id: string;
      matchId: string;
      userId: string;
      status: string;
      position: number;
      respondedAt?: Date;
    }[],
    events: [] as Array<Record<string, unknown> & { insideTransaction: boolean }>,
    /** Flipped for the duration of a $transaction callback. */
    inTransaction: false,
  };
  return { state };
});

vi.mock("../db", () => {
  const rows = () => h.state.rows;
  /** Prisma hands back plain snapshots, not live handles. The double
   *  must too: a later `update` aliasing the row a caller already read
   *  would silently rewrite its own "before" state, and the whole point
   *  of this file is asserting the before/after pair. */
  const snap = <T>(r: T | undefined | null): T | null => (r ? { ...r } : null);
  const attendance = {
    findUnique: async ({
      where,
    }: {
      where: { matchId_userId: { matchId: string; userId: string } };
    }) =>
      snap(
        rows().find(
          (r) =>
            r.matchId === where.matchId_userId.matchId &&
            r.userId === where.matchId_userId.userId,
        ),
      ),
    findMany: async ({
      where,
      orderBy,
    }: {
      where: { matchId: string; status?: { in: string[] } };
      orderBy?: { position: "asc" };
    }) => {
      const out = rows().filter(
        (r) =>
          r.matchId === where.matchId &&
          (!where.status || where.status.in.includes(r.status)),
      );
      if (orderBy) out.sort((a, b) => a.position - b.position);
      return out;
    },
    aggregate: async ({ where }: { where: { matchId: string } }) => ({
      _max: {
        position: rows()
          .filter((r) => r.matchId === where.matchId)
          .reduce<number | null>((m, r) => (m === null || r.position > m ? r.position : m), null),
      },
    }),
    count: async ({ where }: { where: { matchId: string; status: string } }) =>
      rows().filter((r) => r.matchId === where.matchId && r.status === where.status).length,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { matchId_userId: { matchId: string; userId: string } };
      create: { matchId: string; userId: string; status: string; position: number };
      update: { status: string; position: number; respondedAt: Date };
    }) => {
      const found = rows().find(
        (r) =>
          r.matchId === where.matchId_userId.matchId &&
          r.userId === where.matchId_userId.userId,
      );
      if (found) {
        Object.assign(found, update);
        return { ...found };
      }
      const row = { id: `a-${rows().length + 1}`, ...create };
      rows().push(row);
      return { ...row };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id?: string; matchId_userId?: { matchId: string; userId: string } };
      data: Record<string, unknown>;
    }) => {
      const found = where.id
        ? rows().find((r) => r.id === where.id)
        : rows().find(
            (r) =>
              r.matchId === where.matchId_userId!.matchId &&
              r.userId === where.matchId_userId!.userId,
          );
      if (!found) throw new Error("row not found");
      Object.assign(found, data);
      return { ...found };
    },
  };

  const attendanceEvent = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      h.state.events.push({ ...data, insideTransaction: h.state.inTransaction });
      return data;
    },
  };

  const base = {
    match: {
      findUnique: async () => ({
        id: "m1",
        maxPlayers: h.state.maxPlayers,
        date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        activity: { orgId: "org1" },
      }),
      findFirst: async () => null,
    },
    attendance,
    attendanceEvent,
    benchSlotOffer: {
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
    },
    sentNotification: { deleteMany: async () => ({ count: 0 }) },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      h.state.inTransaction = true;
      try {
        return await fn(base);
      } finally {
        h.state.inTransaction = false;
      }
    },
  };

  return { db: base };
});

vi.mock("../bot-scheduler", () => ({
  requestBenchConfirmationOnDrop: async () => {},
  queueSlotEmojiRefresh: async () => {},
}));
vi.mock("../squad-announce", () => ({
  announceSquadFullIfJustFilled: async () => {},
}));

const { registerAttendance, cancelAttendance } = await import("../attendance");

const SELF = { cause: "self-attendance", actorKind: "player" } as const;

beforeEach(() => {
  h.state.rows = [];
  h.state.events = [];
  h.state.maxPlayers = 3;
  h.state.inTransaction = false;
});

describe("registerAttendance", () => {
  it("records a first registration, inside the transaction that made it", async () => {
    await registerAttendance("u1", "m1", { event: { ...SELF, actorUserId: "u1" } });
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0]).toMatchObject({
      matchId: "m1",
      orgId: "org1",
      userId: "u1",
      fromStatus: null,
      toStatus: "CONFIRMED",
      cause: "self-attendance",
      actorKind: "player",
      actorUserId: "u1",
      insideTransaction: true,
    });
  });

  it("records the CAPACITY bench — the squad was full, nobody asked for it", async () => {
    h.state.maxPlayers = 1;
    await registerAttendance("u1", "m1", { event: SELF });
    await registerAttendance("u2", "m1", { event: SELF });
    expect(h.state.events).toHaveLength(2);
    expect(h.state.events[1]).toMatchObject({ toStatus: "BENCH", fromStatus: null });
    // The reason a player is on the bench is exactly what the bench
    // incidents turned on, so it is written down rather than inferred.
    expect(String(h.state.events[1].note)).toMatch(/squad full/i);
  });

  it("records an EXPLICIT bench demotion of a confirmed player", async () => {
    await registerAttendance("u1", "m1", { event: SELF });
    h.state.events = [];
    await registerAttendance("u1", "m1", {
      benchIntent: "explicit",
      event: { cause: "admin-message", actorKind: "admin", actorUserId: "admin-1" },
    });
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0]).toMatchObject({
      fromStatus: "CONFIRMED",
      toStatus: "BENCH",
      cause: "admin-message",
      actorKind: "admin",
      insideTransaction: true,
    });
  });

  it("records a bench PROMOTION when a slot was free", async () => {
    h.state.maxPlayers = 1;
    await registerAttendance("u1", "m1", { event: SELF });
    await registerAttendance("u2", "m1", { event: SELF }); // → BENCH
    h.state.maxPlayers = 3;
    h.state.events = [];
    await registerAttendance("u2", "m1", { promoteFromBench: true, event: SELF });
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0]).toMatchObject({ fromStatus: "BENCH", toStatus: "CONFIRMED" });
  });

  it("writes NOTHING for the idempotent no-op — an audit log is not a hit counter", async () => {
    await registerAttendance("u1", "m1", { event: SELF });
    h.state.events = [];
    await registerAttendance("u1", "m1", { event: SELF });
    expect(h.state.events).toHaveLength(0);
  });

  it("an unattributed caller still lands in the log, marked as such", async () => {
    // scripts/*.ts are excluded from tsc, so this is the ONLY way in.
    await (registerAttendance as unknown as (u: string, m: string) => Promise<unknown>)("u1", "m1");
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0]).toMatchObject({
      cause: "maintenance-script",
      actorKind: "script",
    });
  });
});

describe("cancelAttendance", () => {
  it("records the drop with the cause the caller named", async () => {
    await registerAttendance("u1", "m1", { event: SELF });
    h.state.events = [];
    await cancelAttendance("u1", "m1", { ...SELF, actorUserId: "u1", sourceRef: "wa-9" });
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0]).toMatchObject({
      fromStatus: "CONFIRMED",
      toStatus: "DROPPED",
      cause: "self-attendance",
      actorKind: "player",
      sourceRef: "wa-9",
      insideTransaction: true,
    });
  });

  it("a third-party OUT is a DIFFERENT fact from a self-OUT, and the log says so", async () => {
    await registerAttendance("u1", "m1", { event: SELF });
    h.state.events = [];
    await cancelAttendance("u1", "m1", {
      cause: "third-party-attendance",
      actorKind: "member",
      actorUserId: "u2",
    });
    expect(h.state.events[0]).toMatchObject({
      userId: "u1",
      actorUserId: "u2",
      cause: "third-party-attendance",
    });
  });
});
