/**
 * WHO MAY BECOME WHAT AT A CLUB (2026-10-20, FNF).
 *
 * Hamzah created FNF through self-join as OWNER and was later found as
 * ADMIN with no record of who changed it. The rule pinned here: an
 * OWNER's role never changes through a role edit, and nothing becomes
 * OWNER through one unless the caller is a path that is allowed to name
 * the owner (onboarding, with no owner yet). Merges are not role edits:
 * they keep the higher role, which can never lower an OWNER.
 */
import { describe, it, expect } from "vitest";
import { planRoleChange, higherRole, planOwnershipTransfer } from "@/lib/role-change-rules";

describe("planRoleChange", () => {
  it("refuses to move an OWNER to ADMIN or PLAYER", () => {
    expect(planRoleChange("OWNER", "ADMIN")).toEqual({ kind: "refused", reason: "owner-locked" });
    expect(planRoleChange("OWNER", "PLAYER")).toEqual({ kind: "refused", reason: "owner-locked" });
  });

  it("refuses to make anybody OWNER unless the path may name the owner", () => {
    expect(planRoleChange("PLAYER", "OWNER")).toEqual({ kind: "refused", reason: "owner-grant" });
    expect(planRoleChange("ADMIN", "OWNER")).toEqual({ kind: "refused", reason: "owner-grant" });
    expect(planRoleChange("PLAYER", "OWNER", { mayGrantOwner: true })).toEqual({ kind: "change" });
  });

  it("refuses a role that is not a role", () => {
    expect(planRoleChange("PLAYER", "SUPERADMIN")).toEqual({ kind: "refused", reason: "invalid-role" });
    expect(planRoleChange("PLAYER", "")).toEqual({ kind: "refused", reason: "invalid-role" });
  });

  it("calls the same role unchanged, OWNER included", () => {
    expect(planRoleChange("ADMIN", "ADMIN")).toEqual({ kind: "unchanged" });
    expect(planRoleChange("OWNER", "OWNER")).toEqual({ kind: "unchanged" });
  });

  it("lets a PLAYER become ADMIN and an ADMIN become PLAYER", () => {
    expect(planRoleChange("PLAYER", "ADMIN")).toEqual({ kind: "change" });
    expect(planRoleChange("ADMIN", "PLAYER")).toEqual({ kind: "change" });
  });
});

describe("higherRole (merges)", () => {
  it("keeps the higher of two roles, so an OWNER is never lowered", () => {
    expect(higherRole("OWNER", "PLAYER")).toBe("OWNER");
    expect(higherRole("PLAYER", "OWNER")).toBe("OWNER");
    expect(higherRole("ADMIN", "PLAYER")).toBe("ADMIN");
    expect(higherRole("PLAYER", "PLAYER")).toBe("PLAYER");
  });
});

describe("planOwnershipTransfer (one owner per club)", () => {
  const base = { actorUserId: "a", targetUserId: "b", targetRole: "ADMIN" as const, targetActive: true };

  it("only the OWNER may hand ownership on", () => {
    expect(planOwnershipTransfer({ ...base, actorRole: "OWNER" })).toEqual({ ok: true });
    expect(planOwnershipTransfer({ ...base, actorRole: "ADMIN" })).toEqual({ ok: false, reason: "not-owner" });
    expect(planOwnershipTransfer({ ...base, actorRole: "PLAYER" })).toEqual({ ok: false, reason: "not-owner" });
    // A superadmin with no membership at the club is not its owner.
    expect(planOwnershipTransfer({ ...base, actorRole: null })).toEqual({ ok: false, reason: "not-owner" });
  });

  it("refuses the owner naming himself, and a target who is not an active member", () => {
    expect(planOwnershipTransfer({ ...base, actorRole: "OWNER", targetUserId: "a" })).toEqual({
      ok: false,
      reason: "self",
    });
    expect(planOwnershipTransfer({ ...base, actorRole: "OWNER", targetRole: null })).toEqual({
      ok: false,
      reason: "not-member",
    });
    expect(planOwnershipTransfer({ ...base, actorRole: "OWNER", targetActive: false })).toEqual({
      ok: false,
      reason: "not-member",
    });
  });

  it("a PLAYER can be made owner too", () => {
    expect(planOwnershipTransfer({ ...base, actorRole: "OWNER", targetRole: "PLAYER" })).toEqual({ ok: true });
  });
});
