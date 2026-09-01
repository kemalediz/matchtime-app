/**
 * The append-only attendance event log — the pure half.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * `Attendance` records what a squad IS. Until this log, nothing
 * recorded what it WAS, and that gap is why `e2e/replay/` can replay
 * only 447 of 1,723 real production messages: 1,149 of them landed in a
 * world whose squad state at that instant was never written down. §10
 * step 6 of the analyzer redesign — the change that can put a player at
 * a pitch with no slot — is supposed to turn on exactly that evidence.
 *
 * So the properties asserted here are the ones that make the log worth
 * trusting, not the ones that are easy to test:
 *
 *   1. A transition that a caller cannot NAME is not recorded. An
 *      unknown cause or actor is a typo becoming a silent hole, and a
 *      silent hole in an audit log is worse than no log.
 *   2. The state of a squad at an ARBITRARY past instant can be
 *      rebuilt from the log alone, and it agrees with the live rows.
 *   3. The cause survives. A drop caused by a bench claim and a
 *      player's own OUT are different facts even though the row ends
 *      up identical, and a replay has to be able to tell them apart.
 *
 * The DATABASE-level guarantees — that an UPDATE or DELETE on the log
 * is rejected, and that an attendance write without an event fails —
 * cannot be asserted here (they are triggers, not TypeScript). They
 * live in `e2e/api/attendance-event-log.spec.ts` against a real
 * Postgres.
 */
import { describe, it, expect } from "vitest";
import {
  ATTENDANCE_ACTOR_KINDS,
  ATTENDANCE_EVENT_CAUSES,
  recordAttendanceEvent,
  squadStateAt,
  type AttendanceEventLike,
} from "../attendance-events";

function sink() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    client: {
      attendanceEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return data;
        },
      },
    },
  };
}

const M = "match-1";
const ORG = "org-1";

describe("recordAttendanceEvent", () => {
  it("records who, what, when, why and what caused it", async () => {
    const s = sink();
    await recordAttendanceEvent(
      s.client,
      {
        matchId: M,
        orgId: ORG,
        userId: "u1",
        fromStatus: null,
        toStatus: "CONFIRMED",
        fromPosition: null,
        toPosition: 3,
      },
      {
        cause: "self-attendance",
        actorKind: "player",
        actorUserId: "u1",
        sourceRef: "wa-123",
        note: "IN",
      },
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({
      matchId: M,
      orgId: ORG,
      userId: "u1",
      fromStatus: null,
      toStatus: "CONFIRMED",
      toPosition: 3,
      cause: "self-attendance",
      actorKind: "player",
      actorUserId: "u1",
      sourceRef: "wa-123",
    });
  });

  it("REFUSES an unnameable cause — a typo must not become a silent hole", async () => {
    const s = sink();
    await expect(
      recordAttendanceEvent(
        s.client,
        { matchId: M, orgId: ORG, userId: "u1", fromStatus: null, toStatus: "CONFIRMED" },
        // deliberately not an AttendanceEventCause
        { cause: "self_attendance" as never, actorKind: "player" },
      ),
    ).rejects.toThrow(/cause/i);
    expect(s.rows).toHaveLength(0);
  });

  it("REFUSES an unnameable actor", async () => {
    const s = sink();
    await expect(
      recordAttendanceEvent(
        s.client,
        { matchId: M, orgId: ORG, userId: "u1", fromStatus: null, toStatus: "CONFIRMED" },
        { cause: "self-attendance", actorKind: "robot" as never },
      ),
    ).rejects.toThrow(/actor/i);
    expect(s.rows).toHaveLength(0);
  });

  it("records a DELETION as toStatus null — the transition the old model lost entirely", async () => {
    const s = sink();
    await recordAttendanceEvent(
      s.client,
      { matchId: M, orgId: ORG, userId: "u1", fromStatus: "CONFIRMED", toStatus: null, fromPosition: 2 },
      { cause: "admin-squad-edit", actorKind: "admin", actorUserId: "admin-1" },
    );
    expect(s.rows[0]).toMatchObject({ fromStatus: "CONFIRMED", toStatus: null });
  });

  it("writes nothing when nothing actually changed", async () => {
    const s = sink();
    await recordAttendanceEvent(
      s.client,
      { matchId: M, orgId: ORG, userId: "u1", fromStatus: "BENCH", toStatus: "BENCH", fromPosition: 4, toPosition: 4 },
      { cause: "self-attendance", actorKind: "player" },
    );
    expect(s.rows).toHaveLength(0);
  });

  it("every declared cause and actor is accepted", async () => {
    for (const cause of ATTENDANCE_EVENT_CAUSES) {
      for (const actorKind of ATTENDANCE_ACTOR_KINDS) {
        const s = sink();
        await recordAttendanceEvent(
          s.client,
          { matchId: M, orgId: ORG, userId: "u1", fromStatus: null, toStatus: "CONFIRMED" },
          { cause, actorKind },
        );
        expect(s.rows).toHaveLength(1);
      }
    }
  });
});

// ── Reconstruction ─────────────────────────────────────────────────────

function ev(
  userId: string,
  from: AttendanceEventLike["fromStatus"],
  to: AttendanceEventLike["toStatus"],
  at: string,
  toPosition: number | null = null,
): AttendanceEventLike {
  return { matchId: M, userId, fromStatus: from, toStatus: to, toPosition, at };
}

describe("squadStateAt — the squad, rebuilt from the log alone", () => {
  /**
   * The scenario is a real week, compressed: four players register, the
   * squad fills, someone drops, the bench player claims the vacated
   * slot, and an admin removes a row that should never have existed.
   */
  const log: AttendanceEventLike[] = [
    ev("a", null, "CONFIRMED", "2026-09-01T10:00:00.000Z", 1),
    ev("b", null, "CONFIRMED", "2026-09-01T11:00:00.000Z", 2),
    ev("c", null, "BENCH", "2026-09-01T12:00:00.000Z", 3),
    ev("d", null, "CONFIRMED", "2026-09-01T13:00:00.000Z", 4),
    ev("a", "CONFIRMED", "DROPPED", "2026-09-02T09:00:00.000Z", 1),
    ev("c", "BENCH", "CONFIRMED", "2026-09-02T09:05:00.000Z", 3),
    ev("d", "CONFIRMED", null, "2026-09-02T10:00:00.000Z", null),
  ];

  it("rebuilds the world BEFORE any of it happened as empty", () => {
    expect(squadStateAt(log, "2026-09-01T09:59:59.000Z")).toEqual([]);
  });

  it("rebuilds an arbitrary MID-WEEK instant, not just the end", () => {
    const at = squadStateAt(log, "2026-09-01T12:30:00.000Z");
    expect(at).toEqual([
      { userId: "a", status: "CONFIRMED", position: 1 },
      { userId: "b", status: "CONFIRMED", position: 2 },
      { userId: "c", status: "BENCH", position: 3 },
    ]);
  });

  it("an instant BETWEEN the drop and the bench claim shows the open slot", () => {
    const at = squadStateAt(log, "2026-09-02T09:02:00.000Z");
    expect(at.filter((p) => p.status === "CONFIRMED").map((p) => p.userId)).toEqual(["b", "d"]);
    expect(at.find((p) => p.userId === "a")?.status).toBe("DROPPED");
    expect(at.find((p) => p.userId === "c")?.status).toBe("BENCH");
  });

  it("a DELETED row disappears from the reconstruction, it does not linger as DROPPED", () => {
    const end = squadStateAt(log, "2026-09-03T00:00:00.000Z");
    expect(end.map((p) => p.userId)).toEqual(["a", "b", "c"]);
    expect(end.find((p) => p.userId === "d")).toBeUndefined();
  });

  it("the reconstruction at NOW equals the live squad", () => {
    // What the Attendance table would hold after that week.
    const live = [
      { userId: "a", status: "DROPPED", position: 1 },
      { userId: "b", status: "CONFIRMED", position: 2 },
      { userId: "c", status: "CONFIRMED", position: 3 },
    ];
    expect(squadStateAt(log, "2026-09-09T00:00:00.000Z")).toEqual(live);
  });

  it("is insensitive to the order the log is handed to it", () => {
    const shuffled = [...log].reverse();
    expect(squadStateAt(shuffled, "2026-09-02T09:02:00.000Z")).toEqual(
      squadStateAt(log, "2026-09-02T09:02:00.000Z"),
    );
  });

  it("only replays the match it was asked about", () => {
    const mixed = [...log, { ...ev("z", null, "CONFIRMED", "2026-09-01T10:30:00.000Z", 9), matchId: "match-2" }];
    expect(squadStateAt(mixed, "2026-09-01T12:30:00.000Z", M).map((p) => p.userId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
