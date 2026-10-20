/**
 * THE PLAYERS PAGE CAN NEVER CHANGE AN OWNER'S ROLE (2026-10-20, FNF).
 *
 * `updatePlayerRole` used to write whatever role it was handed onto any
 * member, OWNER included, and the page's picker only offered Player and
 * Admin. Hamzah, FNF's creator, was found as ADMIN with no record of who
 * changed it. Now: an OWNER is refused and left untouched with nothing
 * logged, and every change that does happen is recorded in RoleChange
 * (who, whose, from, to, where; `createdAt` is when).
 *
 * auth / db / org / next-cache are mocked. No live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const requireOrgAdmin = vi.fn();
const membershipFindUnique = vi.fn();
const membershipUpdate = vi.fn();
const membershipUpdateMany = vi.fn();
const roleChangeCreate = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a),
}));
vi.mock("@/lib/resolve-player", () => ({ findExistingOrgMember: vi.fn() }));
vi.mock("@/lib/merge-players-core", () => ({ mergePlayersCore: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => {
  const client = {
    membership: {
      findUnique: (...a: unknown[]) => membershipFindUnique(...a),
      update: (...a: unknown[]) => membershipUpdate(...a),
      updateMany: (...a: unknown[]) => membershipUpdateMany(...a),
    },
    roleChange: { create: (...a: unknown[]) => roleChangeCreate(...a) },
  };
  return {
    db: { ...client, $transaction: (fn: (tx: typeof client) => unknown) => fn(client) },
  };
});

import { updatePlayerRole, makeOwner } from "@/app/actions/players";

const ACTOR = "user-admin";
const ORG = "org-fnf";
const OWNER = "user-hamzah";
const PLAYER = "user-pat";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: ACTOR } });
  requireOrgAdmin.mockResolvedValue(undefined);
  membershipUpdateMany.mockResolvedValue({ count: 1 });
  roleChangeCreate.mockResolvedValue({});
});

describe("updatePlayerRole", () => {
  it.each(["ADMIN", "PLAYER"] as const)("refuses to set the OWNER to %s, writes and logs nothing", async (to) => {
    membershipFindUnique.mockResolvedValue({ id: "m-owner", role: "OWNER" });

    const res = await updatePlayerRole(OWNER, ORG, to);

    expect(res).toEqual({ ok: false, reason: "owner-locked" });
    expect(membershipUpdate).not.toHaveBeenCalled();
    expect(membershipUpdateMany).not.toHaveBeenCalled();
    expect(roleChangeCreate).not.toHaveBeenCalled();
  });

  it("refuses OWNER as a target even if a caller sends it", async () => {
    membershipFindUnique.mockResolvedValue({ id: "m-pat", role: "PLAYER" });

    const res = await updatePlayerRole(PLAYER, ORG, "OWNER" as unknown as "ADMIN");

    expect(res).toEqual({ ok: false, reason: "owner-grant" });
    expect(membershipUpdateMany).not.toHaveBeenCalled();
    expect(roleChangeCreate).not.toHaveBeenCalled();
  });

  it("checks the caller is an admin of the club first", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Not an admin"));
    await expect(updatePlayerRole(PLAYER, ORG, "ADMIN")).rejects.toThrow("Not an admin");
    expect(membershipUpdateMany).not.toHaveBeenCalled();
  });

  it("makes a player ADMIN and records who, whose, from, to and where", async () => {
    membershipFindUnique.mockResolvedValue({ id: "m-pat", role: "PLAYER" });

    const res = await updatePlayerRole(PLAYER, ORG, "ADMIN");

    expect(res).toEqual({ ok: true, changed: true });
    // The write is conditional on the role it read, so it can never land
    // on a row that became OWNER in between.
    expect(membershipUpdateMany).toHaveBeenCalledWith({
      where: { id: "m-pat", role: "PLAYER" },
      data: { role: "ADMIN" },
    });
    expect(roleChangeCreate).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        userId: PLAYER,
        actorUserId: ACTOR,
        fromRole: "PLAYER",
        toRole: "ADMIN",
        source: "admin-players-page",
      },
    });
  });

  it("an unchanged role writes and logs nothing", async () => {
    membershipFindUnique.mockResolvedValue({ id: "m-pat", role: "ADMIN" });

    const res = await updatePlayerRole(PLAYER, ORG, "ADMIN");

    expect(res).toEqual({ ok: true, changed: false });
    expect(membershipUpdateMany).not.toHaveBeenCalled();
    expect(roleChangeCreate).not.toHaveBeenCalled();
  });
});

describe("makeOwner (one owner per club; only the owner hands it on)", () => {
  const rows = (actor: { role: string; leftAt?: Date | null } | null, target: { role: string; leftAt?: Date | null } | null) => {
    membershipFindUnique.mockImplementation(async (args: { where: { userId_orgId: { userId: string } } }) => {
      const r = args.where.userId_orgId.userId === ACTOR ? actor : target;
      return r ? { id: `m-${args.where.userId_orgId.userId}`, role: r.role, leftAt: r.leftAt ?? null, guestFromOrgId: null } : null;
    });
  };

  it("the owner makes an admin owner: they become OWNER, the old owner ADMIN, both logged", async () => {
    rows({ role: "OWNER" }, { role: "ADMIN" });

    const res = await makeOwner(PLAYER, ORG);

    expect(res).toEqual({ ok: true });
    expect(membershipUpdateMany).toHaveBeenCalledWith({
      where: { id: `m-${ACTOR}`, role: "OWNER" },
      data: { role: "ADMIN" },
    });
    expect(membershipUpdateMany).toHaveBeenCalledWith({
      where: { id: `m-${PLAYER}`, role: "ADMIN" },
      data: { role: "OWNER" },
    });
    expect(roleChangeCreate).toHaveBeenCalledWith({
      data: { orgId: ORG, userId: ACTOR, actorUserId: ACTOR, fromRole: "OWNER", toRole: "ADMIN", source: "ownership-transfer" },
    });
    expect(roleChangeCreate).toHaveBeenCalledWith({
      data: { orgId: ORG, userId: PLAYER, actorUserId: ACTOR, fromRole: "ADMIN", toRole: "OWNER", source: "ownership-transfer" },
    });
  });

  it.each(["ADMIN", "PLAYER"])("a %s cannot make anybody owner, nothing written or logged", async (role) => {
    rows({ role }, { role: "PLAYER" });

    const res = await makeOwner(PLAYER, ORG);

    expect(res).toEqual({ ok: false, reason: "not-owner" });
    expect(membershipUpdateMany).not.toHaveBeenCalled();
    expect(roleChangeCreate).not.toHaveBeenCalled();
  });

  it("a superadmin with no membership at the club cannot make anybody owner", async () => {
    rows(null, { role: "PLAYER" });

    const res = await makeOwner(PLAYER, ORG);

    expect(res).toEqual({ ok: false, reason: "not-owner" });
    expect(membershipUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a target who has left the club", async () => {
    rows({ role: "OWNER" }, { role: "PLAYER", leftAt: new Date() });
    expect(await makeOwner(PLAYER, ORG)).toEqual({ ok: false, reason: "not-member" });
    expect(membershipUpdateMany).not.toHaveBeenCalled();
  });
});
