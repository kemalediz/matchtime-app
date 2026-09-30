/**
 * Rolling squad, the write (plan 1.4): `seedRollingSquad` against an
 * in-memory fake of the Prisma surface it touches.
 *
 *   - the claim is the idempotency key: a second call writes nothing;
 *   - one AttendanceEvent per written row, cause `rolling-squad`, in the
 *     same transaction as the rows;
 *   - positions continue after the target's existing rows;
 *   - a seed that fills the squad writes the `squad-locked` claim so the
 *     "Squad complete" post does not land at 08:00 over the announcement;
 *   - `seedDueRollingSquads` only acts for rolling clubs, and only once
 *     the 08:00 after the source has passed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

interface Att { matchId: string; userId: string; status: string; position: number }
interface Mt {
  id: string;
  date: Date;
  status: string;
  isHistorical: boolean;
  maxPlayers: number;
  activityId: string;
  rollingSeededAt: Date | null;
  rollingSeededFromMatchId: string | null;
  activity: { orgId: string; venue: string; dayOfWeek: number; matchDurationMins: number };
}

const state = {
  matches: [] as Mt[],
  attendance: [] as Att[],
  events: [] as Array<Record<string, unknown>>,
  sent: [] as string[],
  users: new Map<string, { phoneNumber: string | null; email: string; isActive: boolean }>(),
  memberships: new Map<string, { leftAt: Date | null; provisionallyAddedAt: Date | null }>(),
  orgs: [] as Array<{ id: string; rollingSquadEnabled: boolean }>,
};

function matchById(id: string) {
  return state.matches.find((m) => m.id === id) ?? null;
}

const fake = {
  match: {
    findUnique: async ({ where }: { where: { id: string } }) => matchById(where.id),
    findMany: async ({ where }: { where: { activity: { orgId: string } } }) =>
      state.matches.filter((m) => m.activity.orgId === where.activity.orgId),
    updateMany: async ({ where, data }: { where: { id: string; rollingSeededAt: null }; data: Partial<Mt> }) => {
      const m = matchById(where.id);
      if (!m || m.rollingSeededAt) return { count: 0 };
      Object.assign(m, data);
      return { count: 1 };
    },
  },
  attendance: {
    findMany: async ({ where }: { where: { matchId: string } }) =>
      state.attendance
        .filter((a) => a.matchId === where.matchId)
        .map((a) => {
          const u = state.users.get(a.userId)!;
          return { ...a, user: { id: a.userId, ...u } };
        }),
    createMany: async ({ data }: { data: Att[] }) => {
      state.attendance.push(...data);
      return { count: data.length };
    },
  },
  membership: {
    findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
      where.userId.in
        .filter((u) => state.memberships.has(u))
        .map((u) => ({ userId: u, ...state.memberships.get(u)! })),
  },
  attendanceEvent: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      state.events.push(data);
      return data;
    },
  },
  sentNotification: {
    upsert: async ({ where }: { where: { key: string } }) => {
      if (!state.sent.includes(where.key)) state.sent.push(where.key);
      return {};
    },
  },
  organisation: {
    findMany: async () => state.orgs.filter((o) => o.rollingSquadEnabled).map((o) => ({ id: o.id })),
  },
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(fake),
};

vi.mock("@/lib/db", () => ({
  get db() {
    return fake;
  },
}));

import { seedDueRollingSquads, seedRollingSquad } from "../rolling-squad";

const FIX = { orgId: "org-fnf", venue: "Powerleague", dayOfWeek: 5, matchDurationMins: 60 };
/** Fri 2 Oct 2026 20:30 BST and Fri 9 Oct 2026 20:30 BST. */
const LAST = new Date("2026-10-02T19:30:00.000Z");
const NEXT = new Date("2026-10-09T19:30:00.000Z");
const SAT_0805 = new Date("2026-10-03T07:05:00.000Z");
const SAT_0755 = new Date("2026-10-03T06:55:00.000Z");

function reset(maxPlayers = 18) {
  state.matches = [
    { id: "last", date: LAST, status: "COMPLETED", isHistorical: false, maxPlayers: 18, activityId: "a9", rollingSeededAt: null, rollingSeededFromMatchId: null, activity: FIX },
    { id: "next", date: NEXT, status: "UPCOMING", isHistorical: false, maxPlayers, activityId: "a9", rollingSeededAt: null, rollingSeededFromMatchId: null, activity: FIX },
  ];
  state.attendance = [
    { matchId: "last", userId: "hamzah", status: "CONFIRMED", position: 1 },
    { matchId: "last", userId: "raihan", status: "CONFIRMED", position: 2 },
    { matchId: "last", userId: "wasim", status: "CONFIRMED", position: 3 },
    { matchId: "last", userId: "benchy", status: "BENCH", position: 4 },
    // Kemal said OUT for next week before the seed: stays OUT.
    { matchId: "next", userId: "kemal", status: "DROPPED", position: 1 },
  ];
  state.attendance.push({ matchId: "last", userId: "kemal", status: "CONFIRMED", position: 5 });
  state.events = [];
  state.sent = [];
  state.users = new Map(
    ["hamzah", "raihan", "wasim", "benchy", "kemal"].map((u) => [
      u,
      { phoneNumber: `+44${u}`, email: `${u}@x.com`, isActive: true },
    ]),
  );
  state.memberships = new Map(
    ["hamzah", "raihan", "wasim", "benchy", "kemal"].map((u) => [u, { leftAt: null, provisionallyAddedAt: null }]),
  );
  state.orgs = [{ id: "org-fnf", rollingSquadEnabled: true }];
}

beforeEach(() => reset());

describe("seedRollingSquad", () => {
  it("carries last week's confirmed players, CONFIRMED, after the existing rows", async () => {
    const res = await seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "scheduler" }, now: SAT_0805 });
    expect(res).toEqual({ seeded: true, carried: 3, overflow: 0 });
    const next = state.attendance.filter((a) => a.matchId === "next");
    expect(next.map((a) => [a.userId, a.status, a.position])).toEqual([
      ["kemal", "DROPPED", 1],
      ["hamzah", "CONFIRMED", 2],
      ["raihan", "CONFIRMED", 3],
      ["wasim", "CONFIRMED", 4],
    ]);
    expect(matchById("next")?.rollingSeededFromMatchId).toBe("last");
    expect(matchById("next")?.rollingSeededAt).toEqual(SAT_0805);
  });

  it("writes one rolling-squad event per row", async () => {
    await seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "scheduler" }, now: SAT_0805 });
    expect(state.events).toHaveLength(3);
    for (const e of state.events) {
      expect(e).toMatchObject({
        matchId: "next",
        orgId: "org-fnf",
        cause: "rolling-squad",
        actorKind: "scheduler",
        actorUserId: null,
        sourceRef: "last",
        fromStatus: null,
        toStatus: "CONFIRMED",
      });
      expect(String(e.note)).toMatch(/^carried over from 2026-10-02$/);
    }
  });

  it("is idempotent: the second call writes nothing", async () => {
    await seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "scheduler" }, now: SAT_0805 });
    const again = await seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "scheduler" }, now: SAT_0805 });
    expect(again).toEqual({ seeded: false, carried: 0, overflow: 0 });
    expect(state.events).toHaveLength(3);
  });

  it("an admin press is recorded as the admin", async () => {
    await seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "admin", userId: "hamzah" }, now: SAT_0805 });
    expect(state.events[0]).toMatchObject({ actorKind: "admin", actorUserId: "hamzah" });
  });

  it("overflow goes to the bench and a full seed claims squad-locked", async () => {
    reset(2);
    const res = await seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "scheduler" }, now: SAT_0805 });
    expect(res).toEqual({ seeded: true, carried: 3, overflow: 1 });
    expect(state.attendance.find((a) => a.matchId === "next" && a.userId === "wasim")?.status).toBe("BENCH");
    expect(state.sent).toContain("next:squad-locked");
  });

  it("a seed that leaves places open does not claim squad-locked", async () => {
    await seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "scheduler" }, now: SAT_0805 });
    expect(state.sent).toEqual([]);
  });
});

describe("seedDueRollingSquads", () => {
  it("seeds at 08:00 the morning after, not before", async () => {
    expect(await seedDueRollingSquads(SAT_0755)).toEqual({ seeded: 0 });
    expect(state.events).toHaveLength(0);
    expect(await seedDueRollingSquads(SAT_0805)).toEqual({ seeded: 1 });
    expect(await seedDueRollingSquads(SAT_0805)).toEqual({ seeded: 0 });
  });

  it("does nothing for a club with the setting off", async () => {
    state.orgs = [{ id: "org-fnf", rollingSquadEnabled: false }];
    expect(await seedDueRollingSquads(SAT_0805)).toEqual({ seeded: 0 });
    expect(state.attendance.filter((a) => a.matchId === "next")).toHaveLength(1);
  });

  it("after a cancelled week, seeds from the last PLAYED match within 21 days", async () => {
    // last (2 Oct) played, 9 Oct cancelled, 16 Oct is the target.
    const cancelled = matchById("next")!;
    cancelled.status = "CANCELLED";
    state.matches.push({
      ...cancelled,
      id: "wk3",
      date: new Date("2026-10-16T19:30:00.000Z"),
      status: "UPCOMING",
    });
    const res = await seedDueRollingSquads(new Date("2026-10-10T07:05:00.000Z"));
    expect(res).toEqual({ seeded: 1 });
    expect(matchById("wk3")?.rollingSeededFromMatchId).toBe("last");
  });

  it("a longer gap seeds nothing", async () => {
    const next = matchById("next")!;
    next.date = new Date("2026-10-30T20:30:00.000Z");
    expect(await seedDueRollingSquads(new Date("2026-10-24T07:05:00.000Z"))).toEqual({ seeded: 0 });
  });
});
