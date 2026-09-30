/**
 * Rolling squad (plan 1.6): an OUT after the drop-out deadline.
 *
 *   - it is RECORDED like any other OUT (the squad must be true);
 *   - lateness is judged by when the player SENT it (`occurredAt`), not
 *     when it reached us;
 *   - the AttendanceEvent note says it was late;
 *   - the club's admins get ONE notice, through the one function slice 2
 *     will re-route (`sendClubAdminNotice`);
 *   - a club without the setting (Sutton) is untouched: no note, no DM.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    rolling: true,
    rows: [] as Array<{ id: string; matchId: string; userId: string; status: string; position: number }>,
    events: [] as Array<Record<string, unknown>>,
    notices: [] as Array<{ orgId: string; text: string }>,
  },
}));

/** Fri 9 Oct 2026 20:30 London; deadline Fri 15:30 London. */
const KICKOFF = new Date("2026-10-09T19:30:00.000Z");
const DEADLINE = new Date("2026-10-09T14:30:00.000Z");

vi.mock("../db", () => {
  const rows = () => h.state.rows;
  const base = {
    match: {
      findUnique: async () => ({
        id: "m1",
        maxPlayers: 18,
        date: KICKOFF,
        attendanceDeadline: DEADLINE,
        activity: { orgId: "org1", name: "Friday 9-a-side", org: { rollingSquadEnabled: h.state.rolling, language: "en" } },
      }),
    },
    user: { findUnique: async () => ({ name: "Wasim Ali" }) },
    attendance: {
      findUnique: async ({ where }: { where: { matchId_userId: { userId: string } } }) => {
        const r = rows().find((x) => x.userId === where.matchId_userId.userId);
        return r ? { ...r } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows().find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return { ...r };
      },
      count: async ({ where }: { where: { status: string } }) => rows().filter((r) => r.status === where.status).length,
    },
    attendanceEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.state.events.push(data);
        return data;
      },
    },
    sentNotification: { deleteMany: async () => ({ count: 0 }) },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(base);
    },
  };
  return { db: base };
});
vi.mock("../bot-scheduler", () => ({
  requestBenchConfirmationOnDrop: async () => {},
  queueSlotEmojiRefresh: async () => {},
}));
vi.mock("../squad-announce", () => ({ announceSquadFullIfJustFilled: async () => {} }));
vi.mock("../admin-notice", () => ({
  sendClubAdminNotice: async (a: { orgId: string; text: string }) => {
    h.state.notices.push(a);
    return { queued: 1 };
  },
}));

const { cancelAttendance } = await import("../attendance");
const SELF = { cause: "self-attendance", actorKind: "player", actorUserId: "wasim" } as const;

beforeEach(() => {
  h.state.rolling = true;
  h.state.rows = [
    { id: "a1", matchId: "m1", userId: "wasim", status: "CONFIRMED", position: 1 },
    { id: "a2", matchId: "m1", userId: "hamzah", status: "CONFIRMED", position: 2 },
  ];
  h.state.events = [];
  h.state.notices = [];
});

describe("late drop-out, rolling club", () => {
  it("after the deadline: recorded, noted, one admin notice", async () => {
    await cancelAttendance("wasim", "m1", SELF, { occurredAt: new Date("2026-10-09T15:05:00.000Z") });
    expect(h.state.rows[0].status).toBe("DROPPED");
    expect(String(h.state.events[0].note)).toBe("after the drop-out deadline (Friday 15:30)");
    expect(h.state.notices).toEqual([
      {
        orgId: "org1",
        text:
          "Late drop-out: *Wasim Ali* said OUT for *Friday 9-a-side* (Fri 9 Oct at 20:30) at 16:05, " +
          "after the Friday 15:30 deadline. Squad is now 1/18.",
        now: expect.any(Date),
      },
    ]);
  });

  it("sent before the deadline, delivered after: on time", async () => {
    await cancelAttendance("wasim", "m1", SELF, { occurredAt: new Date("2026-10-09T14:25:00.000Z") });
    expect(h.state.rows[0].status).toBe("DROPPED");
    expect(h.state.events[0].note ?? null).toBeNull();
    expect(h.state.notices).toEqual([]);
  });

  it("a bench player's late OUT changes no squad and tells nobody", async () => {
    h.state.rows[0].status = "BENCH";
    await cancelAttendance("wasim", "m1", SELF, { occurredAt: new Date("2026-10-09T15:05:00.000Z") });
    expect(h.state.notices).toEqual([]);
  });

  it("an admin taking a player off after the deadline is not a drop-out notice", async () => {
    await cancelAttendance(
      "wasim",
      "m1",
      { cause: "admin-squad-edit", actorKind: "admin", actorUserId: "hamzah" },
      { occurredAt: new Date("2026-10-09T15:05:00.000Z") },
    );
    expect(h.state.rows[0].status).toBe("DROPPED");
    expect(h.state.notices).toEqual([]);
  });
});

describe("a club without the setting (Sutton)", () => {
  it("a late OUT is recorded exactly as before: no note, no notice", async () => {
    h.state.rolling = false;
    await cancelAttendance("wasim", "m1", SELF, { occurredAt: new Date("2026-10-09T15:05:00.000Z") });
    expect(h.state.rows[0].status).toBe("DROPPED");
    expect(h.state.events[0].note ?? null).toBeNull();
    expect(h.state.notices).toEqual([]);
  });
});
