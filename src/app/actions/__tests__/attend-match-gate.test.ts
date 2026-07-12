/**
 * Wiring test for the `attendMatch` server action's group-membership
 * gate. Proves the pure `canSelfMarkIn` decision is actually enforced
 * on the app self-IN path: a non-group-member is blocked (with the
 * friendly, club-named error) and registerAttendance is NEVER called,
 * while a real group member sails through to registerAttendance.
 *
 * auth / db / attendance / next-cache are mocked — no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const matchFindUnique = vi.fn();
const membershipFindUnique = vi.fn();
const registerAttendance = vi.fn();
const cancelAttendance = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    membership: { findUnique: (...a: unknown[]) => membershipFindUnique(...a) },
  },
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
