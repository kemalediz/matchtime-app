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
  /** When the match was last written: a cancelled match's cancel time. */
  updatedAt?: Date;
  activity: { orgId: string; venue: string; dayOfWeek: number; matchDurationMins: number };
}

const state = {
  matches: [] as Mt[],
  attendance: [] as Att[],
  events: [] as Array<Record<string, unknown>>,
  /** AttendanceEvent rows written before the test: the club's history. */
  history: [] as Array<{
    orgId: string;
    userId: string;
    actorKind: string;
    cause: string;
    toStatus: string | null;
    sourceRef?: string | null;
  }>,
  /** AttendanceEvent rows of cancelled weeks, with their times. */
  weekEvents: [] as Array<{
    matchId: string;
    userId: string;
    fromStatus: string | null;
    toStatus: string | null;
    cause: string;
    at: Date;
    toPosition: number | null;
  }>,
  sent: [] as string[],
  users: new Map<string, { phoneNumber: string | null; email: string; isActive: boolean }>(),
  memberships: new Map<string, { leftAt: Date | null; provisionallyAddedAt: Date | null }>(),
  orgs: [] as Array<{ id: string; rollingSquadEnabled: boolean }>,
  userNames: new Map<string, string>(),
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
    findMany: async ({
      where,
    }: {
      where: { matchId: string | { in: string[] }; userId?: { in: string[] }; status?: { in: string[] } };
    }) =>
      state.attendance
        .filter((a) => (typeof where.matchId === "string" ? a.matchId === where.matchId : where.matchId.in.includes(a.matchId)))
        .filter((a) => !where.userId || where.userId.in.includes(a.userId))
        .filter((a) => !where.status || where.status.in.includes(a.status))
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
    findMany: async ({
      where,
    }: {
      where: {
        matchId?: { in: string[] };
        orgId: string;
        userId: { in: string[] };
        actorKind: string;
        toStatus: { in: string[] };
        OR: Array<{ cause: string; sourceRef: string | { startsWith: string } }>;
      };
    }) =>
      where.matchId
        ? // The cancelled weeks' own history (2026-10-24).
          state.weekEvents.filter((e) => where.matchId!.in.includes(e.matchId))
        : [...state.history, ...(state.events as typeof state.history)]
        .filter(
          (e) =>
            e.orgId === where.orgId &&
            where.userId.in.includes(e.userId) &&
            e.actorKind === where.actorKind &&
            e.toStatus != null &&
            where.toStatus.in.includes(e.toStatus) &&
            where.OR.some(
              (o) =>
                o.cause === e.cause &&
                (typeof o.sourceRef === "string"
                  ? e.sourceRef === o.sourceRef
                  : (e.sourceRef ?? "").startsWith(o.sourceRef.startsWith)),
            ),
        )
        .map((e) => ({ userId: e.userId })),
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
  user: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, name: state.userNames.get(id) ?? null })),
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

import { loadRollingLeftOut, seedDueRollingSquads, seedRollingSquad } from "../rolling-squad";

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
  state.history = [];
  state.weekEvents = [];
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

describe("a phoneless player an admin added (club rehearsal, 2026-10-14)", () => {
  /** A name pasted in the admin group and provisioned: no phone, a
   *  `provisional+` email, the provisional flag set. */
  function addPlaceholder(userId: string) {
    state.attendance.push({ matchId: "last", userId, status: "CONFIRMED", position: 10 + state.attendance.length });
    state.users.set(userId, { phoneNumber: null, email: `provisional+${userId}-abc@matchtime.local`, isActive: true });
    state.memberships.set(userId, { leftAt: null, provisionallyAddedAt: new Date("2026-09-30T12:00:00Z") });
  }
  const carried = (userId: string) => state.attendance.find((a) => a.matchId === "next" && a.userId === userId)?.status ?? null;
  const seed = () => seedRollingSquad({ targetId: "next", sourceId: "last", actor: { kind: "scheduler" }, now: SAT_0805 });

  const admin = (userId: string, cause: string, sourceRef: string, toStatus: string | null = "CONFIRMED") =>
    state.history.push({ orgId: "org-fnf", userId, actorKind: "admin", cause, sourceRef, toStatus });

  it("Uncle, pasted in the admin group and confirmed, is carried to next week", async () => {
    addPlaceholder("uncle");
    admin("uncle", "admin-message", "admin-group:wa-paste");
    await seed();
    expect(carried("uncle")).toBe("CONFIRMED");
  });

  it('an admin-group squad change ("put Mo in" in HQ) counts the same', async () => {
    addPlaceholder("mo");
    admin("mo", "admin-message", "admin-group:wa-hq-1");
    await seed();
    expect(carried("mo")).toBe("CONFIRMED");
  });

  it("an admin's Add to match on the website counts the same", async () => {
    addPlaceholder("uncle");
    admin("uncle", "admin-squad-edit", "admin:addPlayerToMatch");
    await seed();
    expect(carried("uncle")).toBe("CONFIRMED");
  });

  it("he stays carried the week after: the admin's add is in the club's log, not on last week's row", async () => {
    addPlaceholder("uncle");
    admin("uncle", "admin-message", "admin-group:wa-paste");
    // Last week's row was itself written by the seeding, not by the admin.
    state.history.push({ orgId: "org-fnf", userId: "uncle", actorKind: "scheduler", cause: "rolling-squad", sourceRef: "prev", toStatus: "CONFIRMED" });
    await seed();
    expect(carried("uncle")).toBe("CONFIRMED");
  });

  it("a one-off guest another player registered stays excluded", async () => {
    addPlaceholder("gary");
    state.history.push({ orgId: "org-fnf", userId: "gary", actorKind: "member", cause: "third-party-attendance", sourceRef: "wa-9", toStatus: "CONFIRMED" });
    await seed();
    expect(carried("gary")).toBeNull();
  });

  it('an ADMIN\'s "my mate Gary is in" in the PLAYERS\' group stays excluded: a one-off guest, not a member', async () => {
    addPlaceholder("gary");
    // attendance-engine.ts: an admin's third-party add there is cause
    // admin-message, sourceRef the players' group message id.
    admin("gary", "admin-message", "false_120363000000000000@g.us_3EB0ABC");
    await seed();
    expect(carried("gary")).toBeNull();
  });

  it("promoting somebody already registered does not count: move up, promote, reorder, organiser pick, carry over", async () => {
    addPlaceholder("gary");
    admin("gary", "admin-squad-edit", "admin:moveUpFromBench");
    admin("gary", "admin-squad-edit", "admin:promoteFromBench");
    admin("gary", "admin-squad-edit", "admin:reorderWaitingList");
    admin("gary", "organiser-pick", "pick-round-1");
    admin("gary", "rolling-squad", "prev");
    await seed();
    expect(carried("gary")).toBeNull();
  });

  it("an admin removing a guest does not make him admin-added", async () => {
    addPlaceholder("gary");
    admin("gary", "admin-message", "admin-group:wa-out", null);
    await seed();
    expect(carried("gary")).toBeNull();
  });

  it("an admin's add in ANOTHER club does not count here", async () => {
    addPlaceholder("gary");
    state.history.push({ orgId: "org-other", userId: "gary", actorKind: "admin", cause: "admin-message", sourceRef: "admin-group:x", toStatus: "CONFIRMED" });
    await seed();
    expect(carried("gary")).toBeNull();
  });
});

describe("a cancelled week in between (FNF 23 Oct, 2026-10-24)", () => {
  /** 2 Oct played; 9 Oct cancelled on Thu 8 Oct 15:40; 16 Oct is the target. */
  const CANCELLED_AT = new Date("2026-10-08T14:40:00.000Z");
  const WK3 = new Date("2026-10-16T19:30:00.000Z");
  const ev = (userId: string, fromStatus: string | null, toStatus: string, minsBefore: number, cause = "self-attendance", toPosition = 1) =>
    state.weekEvents.push({
      matchId: "next",
      userId,
      fromStatus,
      toStatus,
      cause,
      at: new Date(CANCELLED_AT.getTime() - minsBefore * 60 * 1000),
      toPosition,
    });

  beforeEach(() => {
    const cancelled = matchById("next")!;
    cancelled.status = "CANCELLED";
    cancelled.updatedAt = CANCELLED_AT;
    // Kemal's early OUT on 9 Oct is the row reset() put there.
    state.matches.push({ ...cancelled, id: "wk3", date: WK3, status: "UPCOMING", updatedAt: undefined });
    // Imti said IN for the cancelled week; not on 2 Oct's squad.
    state.users.set("imti", { phoneNumber: "+44imti", email: "imti@x.com", isActive: true });
    state.memberships.set("imti", { leftAt: null, provisionallyAddedAt: null });
    state.attendance.push({ matchId: "next", userId: "imti", status: "CONFIRMED", position: 2 });
  });

  const seedWk3 = () => seedRollingSquad({ targetId: "wk3", sourceId: "last", actor: { kind: "scheduler" }, now: new Date("2026-10-10T07:05:00.000Z") });
  const onWk3 = () => state.attendance.filter((a) => a.matchId === "wk3").map((a) => [a.userId, a.status]);

  it("a player who said OUT for it is not carried; a player who said IN for it is, after last week's squad", async () => {
    ev("kemal", "CONFIRMED", "DROPPED", 600);
    ev("raihan", "CONFIRMED", "DROPPED", 300, "admin-message");
    ev("imti", null, "CONFIRMED", 200, "admin-message", 2);
    await seedWk3();
    expect(onWk3()).toEqual([
      ["hamzah", "CONFIRMED"],
      ["wasim", "CONFIRMED"],
      ["imti", "CONFIRMED"],
    ]);
    const imti = state.events.find((e) => e.matchId === "wk3" && e.userId === "imti");
    expect(String(imti?.note)).toBe("carried over (IN for the cancelled week) from 2026-10-02");
  });

  it("an OUT sent after the cancellation is not a statement about playing", async () => {
    state.weekEvents.push({ matchId: "next", userId: "raihan", fromStatus: "CONFIRMED", toStatus: "DROPPED", cause: "self-attendance", at: new Date(CANCELLED_AT.getTime() + 60_000), toPosition: 2 });
    await seedWk3();
    expect(onWk3().map(([u]) => u)).toEqual(["hamzah", "raihan", "wasim", "kemal"]);
  });

  it("loadRollingLeftOut names who was left out, and not anyone who has since said IN", async () => {
    ev("kemal", "CONFIRMED", "DROPPED", 600);
    ev("raihan", "CONFIRMED", "DROPPED", 300, "admin-message");
    await seedWk3();
    state.userNames = new Map([["kemal", "Kemal"], ["raihan", "Raihan"]]);
    expect(await loadRollingLeftOut("wk3")).toEqual([
      { userId: "raihan", name: "Raihan" },
      { userId: "kemal", name: "Kemal" },
    ]);
    state.attendance.push({ matchId: "wk3", userId: "kemal", status: "CONFIRMED", position: 9 });
    expect(await loadRollingLeftOut("wk3")).toEqual([{ userId: "raihan", name: "Raihan" }]);
  });

  it("a match that was never seeded names nobody", async () => {
    expect(await loadRollingLeftOut("wk3")).toEqual([]);
  });
});
