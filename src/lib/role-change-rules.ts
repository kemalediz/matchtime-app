/**
 * Who may become what at a club (2026-10-20, FNF). Pure; the database
 * side is src/lib/role-change.ts. Kemal's rules:
 *
 *   - An OWNER is also an admin: every admin gate passes for OWNER.
 *   - A club has ONE owner. Nobody but the owner changes the owner's
 *     role, and the owner does it only by handing ownership to another
 *     member (planOwnershipTransfer), who becomes OWNER while the old
 *     owner becomes ADMIN. A plain role edit never changes an OWNER, the
 *     owner's own included, since that would leave the club with none.
 *   - Nothing becomes OWNER through a role edit, unless the caller is a
 *     path allowed to name the first owner (onboarding, with none yet).
 *   - A platform superadmin is treated as a non-owner: without an OWNER
 *     membership at the club he cannot change or hand on its ownership.
 */

export const MEMBER_ROLES = ["OWNER", "ADMIN", "PLAYER"] as const;
export type MemberRoleName = (typeof MEMBER_ROLES)[number];

/** Where a role change came from, as stored in RoleChange.source. */
export type RoleChangeSource =
  /** An admin on /admin/players (updatePlayerRole). */
  | "admin-players-page"
  /** The onboarding conversation naming the club's owner or first admin. */
  | "onboarding-owner"
  /** The onboarding conversation adding the extra admins it was given. */
  | "onboarding-admin"
  /** Merging two player records: the kept row takes the higher role. */
  | "merge"
  /** The owner handing ownership to another member (makeOwner). */
  | "ownership-transfer";

export type RoleRefusal = "owner-locked" | "owner-grant" | "invalid-role";

export type RoleChangePlan = { kind: "change" } | { kind: "unchanged" } | { kind: "refused"; reason: RoleRefusal };

export function isMemberRole(v: unknown): v is MemberRoleName {
  return typeof v === "string" && (MEMBER_ROLES as readonly string[]).includes(v);
}

export function planRoleChange(
  from: MemberRoleName,
  to: string,
  opts: { mayGrantOwner?: boolean } = {},
): RoleChangePlan {
  if (!isMemberRole(to)) return { kind: "refused", reason: "invalid-role" };
  if (from === to) return { kind: "unchanged" };
  if (from === "OWNER") return { kind: "refused", reason: "owner-locked" };
  if (to === "OWNER" && !opts.mayGrantOwner) return { kind: "refused", reason: "owner-grant" };
  return { kind: "change" };
}

const RANK: Record<MemberRoleName, number> = { OWNER: 3, ADMIN: 2, PLAYER: 1 };

/** The higher of two roles. A merge keeps this, so it can never lower an OWNER. */
export function higherRole(a: MemberRoleName, b: MemberRoleName): MemberRoleName {
  return RANK[b] > RANK[a] ? b : a;
}

export type TransferRefusal = "not-owner" | "self" | "not-member";

/**
 * May `actor` hand the club's ownership to `target`? Only the club's
 * OWNER may, to another active member of the club. `actorRole` and
 * `targetRole` are null when that person has no membership here.
 */
export function planOwnershipTransfer(a: {
  actorUserId: string;
  actorRole: MemberRoleName | null;
  targetUserId: string;
  targetRole: MemberRoleName | null;
  targetActive: boolean;
}): { ok: true } | { ok: false; reason: TransferRefusal } {
  if (a.actorRole !== "OWNER") return { ok: false, reason: "not-owner" };
  if (a.actorUserId === a.targetUserId) return { ok: false, reason: "self" };
  if (!a.targetRole || !a.targetActive) return { ok: false, reason: "not-member" };
  return { ok: true };
}
