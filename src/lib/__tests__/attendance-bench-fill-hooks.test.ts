/**
 * registerAttendance's two hooks into the bench fill (2026-11-17):
 *
 *   1. an explicit bench request while a place is free is written with
 *      `EXPLICIT_BENCH_WITH_ROOM_NOTE`, so the bench never moves that
 *      player up by itself (he chose to wait); on a FULL squad it keeps
 *      the plain note (he is a reserve and moves up in his turn);
 *   2. a CONFIRMED player moved to the bench on purpose opens a place,
 *      and the first one waiting takes it (`fillOpenPlacesFromBench`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  maxPlayers: 14,
  rows: [] as { id: string; matchId: string; userId: string; status: string; position: number }[],
  notes: [] as Array<{ userId: string; toStatus: string | null; note: string | null }>,
  fill: vi.fn(async () => ({ moved: [] as string[] })),
}));

vi.mock("../db", () => {
  const rows = () => h.rows;
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
          maxPlayers: h.maxPlayers,
          date: new Date(Date.now() + 3 * 24 * 3_600_000),
          activity: { orgId: "org1", org: { benchPickMode: "first-come", squadMode: "weekly" } },
        }),
        findFirst: async () => null,
      },
      attendance: {
        // A copy, as Prisma returns: the caller's `existing` must not change under it.
        findUnique: async ({ where }: { where: { matchId_userId: { userId: string } } }) => {
          const r = rows().find((x) => x.userId === where.matchId_userId.userId);
          return r ? { ...r } : null;
        },
        findMany: async ({ where }: { where: { status?: { in: string[] } } }) =>
          rows().filter((r) => !where.status || where.status.in.includes(r.status)).sort((a, b) => a.position - b.position),
        aggregate: async () => ({ _max: { position: rows().reduce((m, r) => Math.max(m, r.position), 0) } }),
        count: async ({ where }: { where: { status: string } }) => rows().filter((r) => r.status === where.status).length,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { matchId_userId: { userId: string } };
          create: { matchId: string; userId: string; status: string; position: number };
          update: { status: string; position: number };
        }) => {
          const found = rows().find((r) => r.userId === where.matchId_userId.userId);
          if (found) return Object.assign(found, update);
          const row = { id: `a-${rows().length + 1}`, ...create };
          rows().push(row);
          return row;
        },
      },
      benchSlotOffer: { updateMany: async () => ({ count: 0 }), findFirst: async () => null, count: async () => 0 },
      guestPlace: { updateMany: async () => ({ count: 0 }) },
      attendanceEvent: {
        create: async ({ data }: { data: { userId: string; toStatus: string | null; note: string | null } }) => {
          h.notes.push({ userId: data.userId, toStatus: data.toStatus, note: data.note });
          return data;
        },
      },
    }),
  };
});
vi.mock("../bot-scheduler", () => ({
  requestBenchConfirmationOnDrop: vi.fn(async () => {}),
  queueSlotEmojiRefresh: vi.fn(async () => {}),
}));
vi.mock("../squad-announce", () => ({ announceSquadFullIfJustFilled: vi.fn(async () => null) }));
vi.mock("../bench-fill", () => ({ fillOpenPlacesFromBench: h.fill }));

import { registerAttendance } from "../attendance";
import { EXPLICIT_BENCH_NOTE, EXPLICIT_BENCH_WITH_ROOM_NOTE } from "../attendance-events";

const EV = { cause: "self-attendance", actorKind: "player" } as const;

function seedConfirmed(n: number) {
  h.rows = Array.from({ length: n }, (_, i) => ({ id: `a-${i + 1}`, matchId: "m1", userId: `p${i + 1}`, status: "CONFIRMED", position: i + 1 }));
}

beforeEach(() => {
  h.maxPlayers = 14;
  h.rows = [];
  h.notes = [];
  h.fill.mockClear();
});

describe("the note on an explicit bench request", () => {
  it("places free: written as chosen while places were open", async () => {
    seedConfirmed(10);
    await registerAttendance("erdal", "m1", { benchIntent: "explicit", event: EV });
    expect(h.notes.at(-1)).toEqual({ userId: "erdal", toStatus: "BENCH", note: EXPLICIT_BENCH_WITH_ROOM_NOTE });
  });

  it("squad full ('In as a reserve'): the plain note, he is a reserve", async () => {
    seedConfirmed(14);
    await registerAttendance("erdal", "m1", { benchIntent: "explicit", event: EV });
    expect(h.notes.at(-1)).toEqual({ userId: "erdal", toStatus: "BENCH", note: EXPLICIT_BENCH_NOTE });
  });
});

describe("a CONFIRMED player moved to the bench on purpose", () => {
  it("asks the bench to fill the place he left", async () => {
    seedConfirmed(14);
    h.rows.push({ id: "a-15", matchId: "m1", userId: "zed", status: "BENCH", position: 15 });
    await registerAttendance("p3", "m1", { benchIntent: "explicit", event: EV });
    expect(h.fill).toHaveBeenCalledTimes(1);
    expect(h.fill).toHaveBeenCalledWith("m1", expect.objectContaining({ vacatedByUserId: "p3", actorKind: "system" }));
  });

  it("an ordinary IN never asks the bench to fill anything", async () => {
    seedConfirmed(10);
    await registerAttendance("amir", "m1", { event: EV });
    expect(h.fill).not.toHaveBeenCalled();
  });
});
