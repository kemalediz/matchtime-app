/**
 * The match page's "Remove" (`removePlayerFromMatch`) is the one admin
 * removal that does not go through `cancelAttendance` (it deletes the row
 * outright). It hands the same check the same facts, so a partner guest
 * removed there gets the same one DM (Kemal, 2026-10-22).
 *
 * auth / db / org / next-cache are mocked. No live DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const attFindUnique = vi.fn();
const guest = vi.hoisted(() => ({ tellGuestTakenOffByAdmin: vi.fn(async () => true) }));

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn(async () => undefined) }));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn() }));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("@/lib/partner-guest", () => guest);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => {
  const client = {
    match: { findUnique: async () => ({ activity: { orgId: "mt" } }) },
    attendance: { findUnique: (...a: unknown[]) => attFindUnique(...a), deleteMany: async () => ({ count: 1 }) },
  };
  return { db: { ...client, $transaction: (fn: (tx: typeof client) => unknown) => fn(client) } };
});

import { removePlayerFromMatch } from "@/app/actions/players";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "admin1" } });
});

describe("removePlayerFromMatch and a partner guest", () => {
  it("a live row removed: handed to the guest check", async () => {
    attFindUnique.mockResolvedValue({ status: "CONFIRMED", position: 4 });
    await removePlayerFromMatch("m1", "c1");
    expect(guest.tellGuestTakenOffByAdmin).toHaveBeenCalledWith({ userId: "c1", matchId: "m1" });
  });

  it("a row that was already dropped, or none: nothing to tell", async () => {
    attFindUnique.mockResolvedValue({ status: "DROPPED", position: 4 });
    await removePlayerFromMatch("m1", "c1");
    attFindUnique.mockResolvedValue(null);
    await removePlayerFromMatch("m1", "c1");
    expect(guest.tellGuestTakenOffByAdmin).not.toHaveBeenCalled();
  });

  it("a failure there never fails the removal", async () => {
    attFindUnique.mockResolvedValue({ status: "BENCH", position: 4 });
    guest.tellGuestTakenOffByAdmin.mockRejectedValueOnce(new Error("boom"));
    await expect(removePlayerFromMatch("m1", "c1")).resolves.toEqual({ ok: true });
  });
});
