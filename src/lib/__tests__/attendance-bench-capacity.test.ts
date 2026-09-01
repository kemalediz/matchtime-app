/**
 * The bench-capacity invariant for registerAttendance.
 *
 * THE INVARIANT: a BENCH row means one of exactly two things —
 *   (1) there is no slot for this player (the squad is FULL), or
 *   (2) this player asked not to occupy one (an EXPLICIT bench request).
 * It must NEVER mean "a classifier inferred it".
 *
 * Why it matters (production, 2026-08-31): a 7-a-side match (maxPlayers
 * 14) sat at 10 confirmed with 4 open slots when a third-party offer was
 * misread as the sender's own standing offer. The old code wrote BENCH
 * without ever looking at capacity, so the 17:00 roster posted to the
 * club's WhatsApp group as
 *
 *     *Confirmed (10/14):*  …ten names…
 *     *Bench (1):*  1. Amir
 *
 * A bench alongside four empty slots is not a state the product can
 * render honestly — it reads as though the match silently became a
 * 10-player format. The owner's words: "even the text says 7aside and
 * then it displays squad as if it is 5aside".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    maxPlayers: 14,
    rows: [] as {
      id: string;
      matchId: string;
      userId: string;
      status: string;
      position: number;
      respondedAt?: Date;
    }[],
  };
  return { state };
});

vi.mock("../db", () => {
  const rows = () => h.state.rows;
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
          maxPlayers: h.state.maxPlayers,
          // Future date so the "previous match still in flight" guard runs
          // its query (which we answer with null) — same shape as prod.
          date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
          activity: { orgId: "org1" },
        }),
        findFirst: async () => null,
      },
      attendance: {
        findUnique: async ({
          where,
        }: {
          where: { matchId_userId: { matchId: string; userId: string } };
        }) =>
          rows().find(
            (r) =>
              r.matchId === where.matchId_userId.matchId &&
              r.userId === where.matchId_userId.userId,
          ) ?? null,
        findFirst: async ({ where }: { where: { matchId: string; userId: string } }) =>
          rows().find((r) => r.matchId === where.matchId && r.userId === where.userId) ??
          null,
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
              .reduce<number | null>(
                (m, r) => (m === null || r.position > m ? r.position : m),
                null,
              ),
          },
        }),
        count: async ({ where }: { where: { matchId: string; status: string } }) =>
          rows().filter((r) => r.matchId === where.matchId && r.status === where.status)
            .length,
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
            return found;
          }
          const row = { id: `a-${rows().length + 1}`, ...create };
          rows().push(row);
          return row;
        },
      },
      benchSlotOffer: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => null,
      },
      sentNotification: { deleteMany: async () => ({ count: 0 }) },
      // The append-only attendance log (2026-09-01). This file is about
      // the capacity invariant, not the log, so the double just has to
      // exist and swallow — but it is the SAME object $transaction hands
      // back, which is what keeps the write and its record in one
      // transaction the way production does. What the log CONTAINS is
      // asserted in attendance-event-coverage.test.ts.
      attendanceEvent: { create: async () => ({}) },
    }),
  };
});

vi.mock("../bot-scheduler", () => ({
  requestBenchConfirmationOnDrop: vi.fn(async () => {}),
  queueSlotEmojiRefresh: vi.fn(async () => {}),
}));
vi.mock("../squad-announce", () => ({
  announceSquadFullIfJustFilled: vi.fn(async () => {}),
}));

import { registerAttendance } from "../attendance";

/** Every write names its cause for the append-only log (2026-09-01).
 *  Irrelevant to the capacity invariant under test here; required so a
 *  new caller can never land in the log as "unknown". */
const EV = { cause: "self-attendance", actorKind: "player" } as const;

/** Seed N confirmed players, positions 1..N. */
function seedConfirmed(n: number) {
  h.state.rows = Array.from({ length: n }, (_, i) => ({
    id: `a-${i + 1}`,
    matchId: "m1",
    userId: `p${i + 1}`,
    status: "CONFIRMED",
    position: i + 1,
  }));
}

const bench = () => h.state.rows.filter((r) => r.status === "BENCH");
const confirmed = () => h.state.rows.filter((r) => r.status === "CONFIRMED");
const snapshot = () =>
  h.state.rows.map((r) => `${r.userId}:${r.status}:${r.position}`);

beforeEach(() => {
  h.state.maxPlayers = 14;
  h.state.rows = [];
});

describe("the production incident: a bench row while slots stood open", () => {
  it("does NOT bench an inferred standing offer on a 10/14 squad", async () => {
    seedConfirmed(10);

    const res = await registerAttendance("amir", "m1", { benchIntent: "inferred", event: EV });

    // The bug: this used to be BENCH, producing "Confirmed (10/14)" +
    // "Bench (1): Amir" on the 17:00 roster.
    expect(res.status).not.toBe("BENCH");
    expect(bench()).toHaveLength(0);
  });

  it("leaves a renderable squad: 11/14 confirmed, empty bench", async () => {
    seedConfirmed(10);
    await registerAttendance("amir", "m1", { benchIntent: "inferred", event: EV });

    expect(confirmed()).toHaveLength(11);
    expect(bench()).toHaveLength(0);
    // The invariant, stated the way the roster renderer sees it: you can
    // never have open slots AND a bench at the same time.
    expect(confirmed().length < h.state.maxPlayers && bench().length > 0).toBe(false);
  });
});

describe("BENCH when the squad is FULL (unchanged)", () => {
  it("benches an inferred standing offer at 14/14", async () => {
    seedConfirmed(14);
    const res = await registerAttendance("amir", "m1", { benchIntent: "inferred", event: EV });
    expect(res.status).toBe("BENCH");
    expect(bench().map((r) => r.userId)).toEqual(["amir"]);
  });

  it("benches an explicit bench request at 14/14", async () => {
    seedConfirmed(14);
    const res = await registerAttendance("erdal", "m1", { benchIntent: "explicit", event: EV });
    expect(res.status).toBe("BENCH");
  });
});

describe("the deliberate case: the player ASKED for the bench", () => {
  it("respects an explicit bench request even with slots open", async () => {
    seedConfirmed(10);
    // "put me on the bench" / admin: "move X to the bench". A human named
    // the bench, so we do not promote them into a slot they didn't ask for.
    const res = await registerAttendance("erdal", "m1", { benchIntent: "explicit", event: EV });
    expect(res.status).toBe("BENCH");
    expect(bench().map((r) => r.userId)).toEqual(["erdal"]);
  });
});

describe("existing CONFIRMED row", () => {
  it("an INFERRED bench signal never demotes a confirmed player", async () => {
    seedConfirmed(10);
    const res = await registerAttendance("p3", "m1", { benchIntent: "inferred", event: EV });
    expect(res.status).toBe("CONFIRMED");
    expect(bench()).toHaveLength(0);
    expect(confirmed()).toHaveLength(10);
  });

  it("an INFERRED bench signal never demotes even when the squad is full", async () => {
    seedConfirmed(14);
    const res = await registerAttendance("p3", "m1", { benchIntent: "inferred", event: EV });
    expect(res.status).toBe("CONFIRMED");
    expect(bench()).toHaveLength(0);
  });

  it("an EXPLICIT demote still works and keeps the player's position", async () => {
    seedConfirmed(10);
    const before = h.state.rows.find((r) => r.userId === "p3")!.position;
    const res = await registerAttendance("p3", "m1", { benchIntent: "explicit", event: EV });
    expect(res.status).toBe("BENCH");
    expect(h.state.rows.find((r) => r.userId === "p3")!.position).toBe(before);
    expect(confirmed()).toHaveLength(9);
  });
});

describe("existing BENCH row", () => {
  it("a benched player's own IN is promoted when a slot is free", async () => {
    seedConfirmed(10);
    h.state.rows.push({
      id: "a-11",
      matchId: "m1",
      userId: "amir",
      status: "BENCH",
      position: 11,
    });
    const res = await registerAttendance("amir", "m1", { promoteFromBench: true, event: EV });
    expect(res.status).toBe("CONFIRMED");
  });

  it("an explicit bench request keeps them on the bench (no promotion)", async () => {
    seedConfirmed(10);
    h.state.rows.push({
      id: "a-11",
      matchId: "m1",
      userId: "erdal",
      status: "BENCH",
      position: 11,
    });
    const res = await registerAttendance("erdal", "m1", {
      promoteFromBench: true,
      benchIntent: "explicit",
      event: EV,
    });
    expect(res.status).toBe("BENCH");
  });
});

describe("the ordinary IN path is untouched", () => {
  it("slots open → CONFIRMED", async () => {
    seedConfirmed(10);
    const res = await registerAttendance("greg", "m1", { event: EV });
    expect(res.status).toBe("CONFIRMED");
    expect(res.confirmedCount).toBe(11);
    expect(res.maxPlayers).toBe(14);
  });

  it("squad full → BENCH", async () => {
    seedConfirmed(14);
    const res = await registerAttendance("greg", "m1", { event: EV });
    expect(res.status).toBe("BENCH");
  });
});

describe("idempotency: repeat writes never shuffle positions", () => {
  it("repeats an IN without moving anyone", async () => {
    seedConfirmed(10);
    await registerAttendance("greg", "m1", { event: EV });
    const before = snapshot();

    await registerAttendance("greg", "m1", { event: EV });
    await registerAttendance("greg", "m1", { event: EV });

    expect(snapshot()).toEqual(before);
  });

  it("repeats an explicit bench request without moving anyone", async () => {
    seedConfirmed(14);
    await registerAttendance("erdal", "m1", { benchIntent: "explicit", event: EV });
    const before = snapshot();

    await registerAttendance("erdal", "m1", { benchIntent: "explicit", event: EV });
    await registerAttendance("erdal", "m1", { benchIntent: "explicit", event: EV });

    expect(snapshot()).toEqual(before);
  });

  it("repeats an inferred standing offer without moving anyone", async () => {
    seedConfirmed(10);
    await registerAttendance("amir", "m1", { benchIntent: "inferred", event: EV });
    const before = snapshot();

    await registerAttendance("amir", "m1", { benchIntent: "inferred", event: EV });

    expect(snapshot()).toEqual(before);
  });
});
