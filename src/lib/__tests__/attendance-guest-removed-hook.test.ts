/**
 * THE ONE HOOK for a partner guest taken off a game by the asking club's
 * organisers (Kemal, 2026-10-22). `cancelAttendance` is the writer every
 * admin drop goes through (a group message, the admin group, a pasted
 * list, HQ), and it knows the actor; it hands an ADMIN's drop of a live
 * row to `tellGuestTakenOffByAdmin`, which decides whether he is a guest.
 * The player's own OUT, a member's report and the system's stand-down
 * never reach it, so his own OUT keeps today's single reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ status: "CONFIRMED" as string }));
vi.mock("../db", () => {
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
          maxPlayers: 14,
          date: new Date(Date.now() + 3 * 86400_000),
          attendanceDeadline: new Date(Date.now() + 2 * 86400_000),
          activity: { orgId: "mt", name: "Wednesday 7-a-side", org: { benchPickMode: "first-come", squadMode: "weekly" } },
        }),
      },
      attendance: {
        findUnique: async () => ({ id: "a1", status: h.status, position: 3 }),
        update: async () => ({}),
        count: async () => 0,
      },
      attendanceEvent: { create: async () => ({}) },
      sentNotification: { deleteMany: async () => ({ count: 0 }) },
    }),
  };
});
vi.mock("../bot-scheduler", () => ({ requestBenchConfirmationOnDrop: vi.fn(async () => {}), queueSlotEmojiRefresh: vi.fn(async () => {}) }));
vi.mock("../squad-announce", () => ({ announceSquadFullIfJustFilled: vi.fn(async () => {}) }));
vi.mock("../admin-channel", () => ({ sendAdminNotice: vi.fn(async () => ({ channel: "dm", queued: 1 })) }));
const guest = vi.hoisted(() => ({ tellGuestTakenOffByAdmin: vi.fn(async () => true) }));
vi.mock("../partner-guest", () => guest);

import { cancelAttendance } from "../attendance";

beforeEach(() => {
  h.status = "CONFIRMED";
  guest.tellGuestTakenOffByAdmin.mockClear();
});

describe("cancelAttendance: an admin's drop is handed to the guest check", () => {
  it("an admin's drop in the players' group (cause admin-message)", async () => {
    await cancelAttendance("c1", "m1", { cause: "admin-message", actorKind: "admin", actorUserId: "admin1", sourceRef: "wa-1" });
    expect(guest.tellGuestTakenOffByAdmin).toHaveBeenCalledWith({ userId: "c1", matchId: "m1" });
  });

  it("an admin's drop from the admin group (HQ) or a screen (admin-squad-edit)", async () => {
    await cancelAttendance("c1", "m1", { cause: "admin-message", actorKind: "admin", actorUserId: "admin1", sourceRef: "admin-group:wa-2" });
    await cancelAttendance("c1", "m1", { cause: "admin-squad-edit", actorKind: "admin", actorUserId: "admin1", sourceRef: "admin:x" });
    expect(guest.tellGuestTakenOffByAdmin).toHaveBeenCalledTimes(2);
  });

  it("a guest on the bench is taken off too", async () => {
    h.status = "BENCH";
    await cancelAttendance("c1", "m1", { cause: "admin-message", actorKind: "admin", actorUserId: "admin1" });
    expect(guest.tellGuestTakenOffByAdmin).toHaveBeenCalledTimes(1);
  });

  it("his own OUT, a member's report, the system's stand-down: never", async () => {
    await cancelAttendance("c1", "m1", { cause: "self-attendance", actorKind: "player", actorUserId: "c1" });
    await cancelAttendance("c1", "m1", { cause: "partner-ask", actorKind: "player", actorUserId: "c1" });
    await cancelAttendance("c1", "m1", { cause: "third-party-attendance", actorKind: "member", actorUserId: "p2" });
    await cancelAttendance("c1", "m1", { cause: "partner-ask", actorKind: "system" });
    expect(guest.tellGuestTakenOffByAdmin).not.toHaveBeenCalled();
  });

  it("a row already dropped (a replayed message): never a second DM", async () => {
    h.status = "DROPPED";
    await cancelAttendance("c1", "m1", { cause: "admin-message", actorKind: "admin", actorUserId: "admin1" });
    expect(guest.tellGuestTakenOffByAdmin).not.toHaveBeenCalled();
  });

  it("a failure there never fails the drop", async () => {
    guest.tellGuestTakenOffByAdmin.mockRejectedValueOnce(new Error("boom"));
    await expect(cancelAttendance("c1", "m1", { cause: "admin-message", actorKind: "admin", actorUserId: "admin1" })).resolves.toEqual({ status: "DROPPED" });
  });
});
