/**
 * Wiring test for the `attendMatch` server action's group-membership
 * gate. Proves the pure `canSelfMarkIn` decision is actually enforced
 * on the app self-IN path: a non-group-member is blocked (with the
 * friendly, club-named error) and registerAttendance is NEVER called,
 * while a real group member sails through to registerAttendance.
 *
 * ALSO covers the OUT-OF-BAND group announcement (owner, 2026-08-31): a
 * player marking themselves in on the web app is invisible to the group,
 * so MatchTime posts one line there — but only when the state actually
 * changed, never for a repeat tap.
 *
 * auth / db / attendance / announce / next-cache are mocked — no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const matchFindUnique = vi.fn();
const membershipFindUnique = vi.fn();
const attendanceFindUnique = vi.fn();
const registerAttendance = vi.fn();
const cancelAttendance = vi.fn();
const announce = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    membership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
    attendance: { findUnique: (...a: unknown[]) => attendanceFindUnique(...a) },
  },
}));
vi.mock("@/lib/out-of-band-announce", () => ({
  announceOutOfBandAttendance: (...a: unknown[]) => announce(...a),
}));
vi.mock("@/lib/attendance", () => ({
  registerAttendance: (...a: unknown[]) => registerAttendance(...a),
  cancelAttendance: (...a: unknown[]) => cancelAttendance(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { attendMatch } from "@/app/actions/attendance";

const MATCH = {
  id: "match-1",
  activity: { orgId: "org-1", org: { name: "Sutton FC" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  matchFindUnique.mockResolvedValue(MATCH);
  attendanceFindUnique.mockResolvedValue(null);
  registerAttendance.mockResolvedValue({
    status: "CONFIRMED",
    position: 1,
    slot: 1,
    confirmedCount: 1,
    maxPlayers: 14,
  });
  announce.mockResolvedValue({ announced: true });
});

describe("attendMatch — group-membership gate", () => {
  it("BLOCKS a non-group-member with the club-named error and does NOT register", async () => {
    // Plain player, never seen in the group sync → denied.
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: null,
      role: "PLAYER",
    });

    await expect(attendMatch("match-1")).rejects.toThrow(
      /You need to be in the Sutton FC WhatsApp group to mark yourself in/,
    );
    expect(registerAttendance).not.toHaveBeenCalled();
  });

  it("BLOCKS someone with no membership at all", async () => {
    membershipFindUnique.mockResolvedValue(null);
    await expect(attendMatch("match-1")).rejects.toThrow(/Sutton FC WhatsApp group/);
    expect(registerAttendance).not.toHaveBeenCalled();
  });

  it("ALLOWS a real group member and calls registerAttendance", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: new Date(),
      role: "PLAYER",
    });

    await expect(attendMatch("match-1")).resolves.toBeUndefined();
    expect(registerAttendance).toHaveBeenCalledWith("user-1", "match-1");
  });

  it("ALLOWS an admin who was never seen in the group sync", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: null,
      role: "ADMIN",
    });

    await attendMatch("match-1");
    expect(registerAttendance).toHaveBeenCalledWith("user-1", "match-1");
  });

  it("still requires authentication", async () => {
    authMock.mockResolvedValue(null);
    await expect(attendMatch("match-1")).rejects.toThrow(/Not authenticated/);
    expect(registerAttendance).not.toHaveBeenCalled();
  });
});

describe("attendMatch — out-of-band group announcement", () => {
  beforeEach(() => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: new Date(),
      role: "PLAYER",
    });
  });

  it("announces an app-driven IN, tagged as coming from the app", async () => {
    await attendMatch("match-1");
    expect(announce).toHaveBeenCalledWith({
      matchId: "match-1",
      userId: "user-1",
      before: null,
      after: "CONFIRMED",
      source: "app",
    });
  });

  it("passes the PRIOR status so a repeat tap is recognised as a no-op", async () => {
    // Already confirmed: registerAttendance is idempotent and returns the
    // same status, so before === after and the announcer drops it.
    attendanceFindUnique.mockResolvedValue({ status: "CONFIRMED" });
    await attendMatch("match-1");
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ before: "CONFIRMED", after: "CONFIRMED" }),
    );
  });

  it("reports a bench placement as BENCH, not as a confirmed slot", async () => {
    registerAttendance.mockResolvedValue({
      status: "BENCH",
      position: 15,
      slot: 1,
      confirmedCount: 14,
      maxPlayers: 14,
    });
    await attendMatch("match-1");
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ after: "BENCH" }));
  });

  it("a failing announcement never breaks the registration", async () => {
    announce.mockRejectedValue(new Error("bot job queue down"));
    await expect(attendMatch("match-1")).resolves.toBeUndefined();
    expect(registerAttendance).toHaveBeenCalled();
  });

  it("never announces when the gate blocked the registration", async () => {
    membershipFindUnique.mockResolvedValue({
      leftAt: null,
      lastSeenInGroupAt: null,
      role: "PLAYER",
    });
    await expect(attendMatch("match-1")).rejects.toThrow(/WhatsApp group/);
    expect(announce).not.toHaveBeenCalled();
  });
});
