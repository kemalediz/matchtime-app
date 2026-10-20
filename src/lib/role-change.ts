/**
 * The one way a member's role at a club changes (2026-10-20, FNF).
 *
 * Hamzah created FNF through self-join as OWNER and was later found as
 * ADMIN with nothing recording who changed it. Every path that changes
 * an existing membership's role goes through here, so:
 *   - an OWNER's role is never changed (role-change-rules.ts);
 *   - the write is conditional on the role that was read, so a row that
 *     became OWNER in between is never overwritten;
 *   - every change that happens writes one RoleChange row (who, whose,
 *     from, to, where; createdAt is when) in the same transaction. A
 *     refused or no-op request writes nothing.
 *
 * Creating a membership with a role is not a change and is not logged.
 */
import {
  isMemberRole,
  planOwnershipTransfer,
  planRoleChange,
  type TransferRefusal,
  type MemberRoleName,
  type RoleChangeSource,
  type RoleRefusal,
} from "./role-change-rules";

/** Structural, like AttendanceEventSink: accepts `db`, a `tx` and a test double. */
export interface RoleChangeSink {
  roleChange: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

export interface RoleChangeClient extends RoleChangeSink {
  membership: {
    findUnique(args: {
      where: { userId_orgId: { userId: string; orgId: string } };
      select: { id: true; role: true; leftAt?: true; guestFromOrgId?: true };
    }): Promise<{ id: string; role: string; leftAt?: Date | null; guestFromOrgId?: string | null } | null>;
    updateMany(args: { where: { id: string; role: MemberRoleName }; data: { role: MemberRoleName } }): Promise<{
      count: number;
    }>;
  };
}

export interface RoleChangeRecord {
  orgId: string;
  userId: string;
  actorUserId: string | null;
  fromRole: MemberRoleName;
  toRole: MemberRoleName;
  source: RoleChangeSource;
}

/** Log a change that the caller has just written in the same transaction. */
export async function recordRoleChange(sink: RoleChangeSink, rec: RoleChangeRecord): Promise<void> {
  if (rec.fromRole === rec.toRole) return;
  await sink.roleChange.create({ data: { ...rec } });
}

export type RoleChangeOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; reason: RoleRefusal | "not-member" | "stale" };

export interface ChangeMemberRoleArgs {
  orgId: string;
  userId: string;
  to: string;
  actorUserId: string | null;
  source: RoleChangeSource;
  /** Only a path allowed to name the club's owner sets this. */
  mayGrantOwner?: boolean;
}

/** Change one member's role at one club. Run it inside the caller's transaction. */
export async function changeMemberRoleIn(tx: RoleChangeClient, args: ChangeMemberRoleArgs): Promise<RoleChangeOutcome> {
  const m = await tx.membership.findUnique({
    where: { userId_orgId: { userId: args.userId, orgId: args.orgId } },
    select: { id: true, role: true },
  });
  if (!m || !isMemberRole(m.role)) return { ok: false, reason: "not-member" };
  const from = m.role;
  const plan = planRoleChange(from, args.to, { mayGrantOwner: args.mayGrantOwner });
  if (plan.kind === "refused") return { ok: false, reason: plan.reason };
  if (plan.kind === "unchanged") return { ok: true, changed: false };
  const to = args.to as MemberRoleName;
  const { count } = await tx.membership.updateMany({ where: { id: m.id, role: from }, data: { role: to } });
  if (count === 0) return { ok: false, reason: "stale" };
  await recordRoleChange(tx, {
    orgId: args.orgId,
    userId: args.userId,
    actorUserId: args.actorUserId,
    fromRole: from,
    toRole: to,
    source: args.source,
  });
  return { ok: true, changed: true };
}

/** Change one member's role at one club, in its own transaction. */
export async function changeMemberRole(
  client: { $transaction<T>(fn: (tx: RoleChangeClient) => Promise<T>): Promise<T> },
  args: ChangeMemberRoleArgs,
): Promise<RoleChangeOutcome> {
  return client.$transaction((tx) => changeMemberRoleIn(tx, args));
}

export type TransferOutcome = { ok: true } | { ok: false; reason: TransferRefusal | "stale" };

/**
 * The owner hands the club to another active member: the target becomes
 * OWNER and the old owner becomes ADMIN, one transaction, both changes
 * logged. Only the club's OWNER may (role-change-rules.ts). Both writes
 * are conditional on the roles read, so a concurrent change aborts the
 * whole transfer and the club never ends up with two owners or none.
 */
export async function transferOwnership(
  client: { $transaction<T>(fn: (tx: RoleChangeClient) => Promise<T>): Promise<T> },
  args: { orgId: string; actorUserId: string; targetUserId: string },
): Promise<TransferOutcome> {
  const STALE = new Error("role-change: stale");
  try {
    return await client.$transaction(async (tx) => {
      const read = (userId: string) =>
        tx.membership.findUnique({
          where: { userId_orgId: { userId, orgId: args.orgId } },
          select: { id: true, role: true, leftAt: true, guestFromOrgId: true },
        });
      const [actor, target] = [await read(args.actorUserId), await read(args.targetUserId)];
      const actorRole = actor && !actor.leftAt && isMemberRole(actor.role) ? actor.role : null;
      const targetRole = target && isMemberRole(target.role) ? target.role : null;
      const plan = planOwnershipTransfer({
        actorUserId: args.actorUserId,
        actorRole,
        targetUserId: args.targetUserId,
        targetRole,
        targetActive: !!target && !target.leftAt && !target.guestFromOrgId,
      });
      if (!plan.ok) return plan;
      const from = targetRole as MemberRoleName;

      const demote = await tx.membership.updateMany({
        where: { id: actor!.id, role: "OWNER" },
        data: { role: "ADMIN" },
      });
      if (demote.count !== 1) throw STALE;
      const promote = await tx.membership.updateMany({
        where: { id: target!.id, role: from },
        data: { role: "OWNER" },
      });
      if (promote.count !== 1) throw STALE;

      const common = { orgId: args.orgId, actorUserId: args.actorUserId, source: "ownership-transfer" as const };
      await recordRoleChange(tx, { ...common, userId: args.actorUserId, fromRole: "OWNER", toRole: "ADMIN" });
      await recordRoleChange(tx, { ...common, userId: args.targetUserId, fromRole: from, toRole: "OWNER" });
      return { ok: true } as const;
    });
  } catch (err) {
    if (err === STALE) return { ok: false, reason: "stale" };
    throw err;
  }
}
