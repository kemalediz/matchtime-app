/**
 * Folding one User into another: the database side (2026-11-03).
 *
 * The rules, and why, are in `user-merge-plan.ts`. This file only:
 *   1. reads the snapshot the planner needs (every row naming the source,
 *      plus the target's rows a move could collide with);
 *   2. applies the planner's ops in ONE transaction, with both User rows
 *      locked, and writes the audit (`UserMerge` rows with `detail`);
 *   3. offers a READ ONLY dry run that plans and writes nothing.
 *
 * Both entry points take the client, so scripts (their own PrismaClient)
 * and, later, the admin path can share them.
 *
 * Relation to `mergePlayersCore`: that one deletes the dropped User and
 * moves a fixed list of tables. This one deactivates, covers every column
 * that names a user (schema-checked by
 * src/lib/__tests__/user-merge-schema-coverage.test.ts), and plans before
 * writing so a dry run can show every row. Folding the two together is
 * proposed in the PR, not done here.
 */
// Same loose typing as merge-players-core.ts: the transaction client's
// type changes shape under `$extends` (see src/lib/db.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

import { recordAttendanceEvent, type AttendanceActorKind } from "./attendance-events";
import { recordRoleChange } from "./role-change";
import {
  aliasNorm,
  delegateOf,
  emptyMergeSnapshot,
  pkOf,
  planUserMerge,
  rewriteIdSegments,
  summarisePlan,
  USER_MERGE_REASON,
  USER_REF_COLUMNS,
  type MergePlan,
  type MergeSnapshot,
  type RefRow,
  type UserFacts,
} from "./user-merge-plan";

async function loadUser(tx: Tx, id: string): Promise<UserFacts> {
  const u = await tx.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      phoneNumber: true,
      isActive: true,
      isSuperadmin: true,
      onboarded: true,
      password: true,
      emailVerified: true,
      _count: { select: { accounts: true, sessions: true } },
    },
  });
  if (!u) throw new Error(`user ${id} not found`);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phoneNumber: u.phoneNumber,
    isActive: u.isActive,
    isSuperadmin: u.isSuperadmin,
    onboarded: u.onboarded,
    hasPassword: !!u.password,
    emailVerified: u.emailVerified,
    accountCount: u._count.accounts,
    sessionCount: u._count.sessions,
  };
}

/**
 * The source's rows of a (key, user) table, plus the target's rows with
 * the same keys (the only ones a move can collide with).
 */
async function pair(tx: Tx, delegate: string, S: string, T: string, keyField: string, select: Record<string, true>) {
  const sel = { id: true, userId: true, [keyField]: true, ...select };
  const src: Array<Record<string, unknown>> = await tx[delegate].findMany({ where: { userId: S }, select: sel });
  const keys = [...new Set(src.map((r) => r[keyField]))];
  const tgt: Array<Record<string, unknown>> =
    keys.length === 0 ? [] : await tx[delegate].findMany({ where: { userId: T, [keyField]: { in: keys } }, select: sel });
  return [...src, ...tgt];
}

export async function loadMergeSnapshot(tx: Tx, S: string, T: string): Promise<MergeSnapshot> {
  const source = await loadUser(tx, S);
  const target = S === T ? source : await loadUser(tx, T);
  const snap = emptyMergeSnapshot(source, target);
  if (S === T) return snap;

  snap.priorMerges = await tx.userMerge.findMany({ where: { oldUserId: S }, select: { survivorUserId: true, reason: true } });

  snap.memberships = await tx.membership.findMany({
    where: { userId: { in: [S, T] } },
    select: {
      id: true,
      userId: true,
      orgId: true,
      role: true,
      leftAt: true,
      removedByOrganiserAt: true,
      provisionallyAddedAt: true,
      lastSeenInGroupAt: true,
      seedRating: true,
      matchRating: true,
      guestFromOrgId: true,
      guestMatchId: true,
      guestVia: true,
    },
  });
  const srcOrgs = [...new Set(snap.memberships.filter((r) => r.userId === S).map((r) => r.orgId))];
  const alias = source.name ? aliasNorm(source.name) : null;
  if (alias && srcOrgs.length > 0) {
    snap.aliasesInSourceOrgs = await tx.userAlias.findMany({
      where: { orgId: { in: srcOrgs }, alias },
      select: { id: true, orgId: true, userId: true, alias: true },
    });
  }

  const attSelect = {
    id: true,
    matchId: true,
    userId: true,
    status: true,
    position: true,
    paidAt: true,
    paidViaUserId: true,
    paymentMethod: true,
    paymentAmount: true,
    paymentQuantity: true,
    stripeSessionId: true,
    directPendingAt: true,
    directConfirmedByUserId: true,
    feeWaivedAt: true,
    feeWaivedReason: true,
    feeWaivedByUserId: true,
    match: { select: { activity: { select: { orgId: true } } } },
  };
  const srcAtt = await tx.attendance.findMany({ where: { userId: S }, select: attSelect });
  const attMatchIds = srcAtt.map((a: { matchId: string }) => a.matchId);
  const tgtAtt = attMatchIds.length ? await tx.attendance.findMany({ where: { userId: T, matchId: { in: attMatchIds } }, select: attSelect }) : [];
  snap.attendance = [...srcAtt, ...tgtAtt].map(({ match, ...a }: { match: { activity: { orgId: string } | null } | null }) => ({
    ...(a as object),
    orgId: match?.activity?.orgId ?? "",
  })) as MergeSnapshot["attendance"];

  snap.teamAssignments = (await pair(tx, "teamAssignment", S, T, "matchId", {})) as MergeSnapshot["teamAssignments"];

  const rSel = { id: true, matchId: true, raterId: true, playerId: true };
  const srcRatings = await tx.rating.findMany({ where: { OR: [{ raterId: S }, { playerId: S }] }, select: rSel });
  const rMatches = [...new Set(srcRatings.map((r: { matchId: string }) => r.matchId))];
  const tgtRatings = rMatches.length
    ? await tx.rating.findMany({ where: { matchId: { in: rMatches }, OR: [{ raterId: T }, { playerId: T }], NOT: { OR: [{ raterId: S }, { playerId: S }] } }, select: rSel })
    : [];
  snap.ratings = [...srcRatings, ...tgtRatings];

  const vSel = { id: true, matchId: true, voterId: true, playerId: true };
  const srcVotes = await tx.moMVote.findMany({ where: { OR: [{ voterId: S }, { playerId: S }] }, select: vSel });
  const vMatches = [...new Set(srcVotes.map((r: { matchId: string }) => r.matchId))];
  const tgtVotes = vMatches.length
    ? await tx.moMVote.findMany({ where: { matchId: { in: vMatches }, voterId: T, NOT: { playerId: S } }, select: vSel })
    : [];
  snap.momVotes = [...srcVotes, ...tgtVotes];

  snap.activityPositions = (await pair(tx, "playerActivityPosition", S, T, "activityId", {})) as MergeSnapshot["activityPositions"];
  snap.ratingAdjustments = (await pair(tx, "ratingAdjustment", S, T, "matchId", {})) as MergeSnapshot["ratingAdjustments"];
  snap.rosterSurveyDMs = (await pair(tx, "rosterSurveyDM", S, T, "surveyId", {})) as MergeSnapshot["rosterSurveyDMs"];
  snap.rosterSurveyResponses = (await pair(tx, "rosterSurveyResponse", S, T, "surveyId", {
    response: true,
    rawReply: true,
    classifiedAt: true,
    adminOverride: true,
  })) as MergeSnapshot["rosterSurveyResponses"];
  snap.tentatives = (await pair(tx, "tentativeAvailability", S, T, "matchId", {})) as MergeSnapshot["tentatives"];
  snap.pendingBench = (await pair(tx, "pendingBenchConfirmation", S, T, "matchId", {})) as MergeSnapshot["pendingBench"];
  snap.badges = (await pair(tx, "badgeAnnouncement", S, T, "orgId", { badgeKey: true })) as MergeSnapshot["badges"];
  snap.squadMembers = (await pair(tx, "squadMonthMember", S, T, "monthId", { paidAt: true, paidClaimedAt: true })) as MergeSnapshot["squadMembers"];
  snap.squadCredits = (await pair(tx, "squadCredit", S, T, "orgId", { earnedMatchId: true, voidedAt: true })) as MergeSnapshot["squadCredits"];
  snap.poolProfiles = await tx.poolProfile.findMany({ where: { userId: { in: [S, T] } }, select: { id: true, userId: true, status: true } });
  snap.poolOffers = (await pair(tx, "poolOffer", S, T, "matchId", {})) as MergeSnapshot["poolOffers"];
  snap.poolBlocks = (await pair(tx, "poolBlock", S, T, "orgId", { by: true })) as MergeSnapshot["poolBlocks"];
  snap.guestPlaces = (await pair(tx, "guestPlace", S, T, "matchId", {})) as MergeSnapshot["guestPlaces"];
  snap.clubInvitations = (await pair(tx, "clubInvitation", S, T, "orgId", { status: true })) as MergeSnapshot["clubInvitations"];

  snap.sentNotifications = await tx.sentNotification.findMany({
    where: { OR: [{ key: { contains: S } }, { targetUser: S }] },
    select: { id: true, key: true, targetUser: true },
  });
  const rewritten = snap.sentNotifications.map((n) => rewriteIdSegments(n.key, S, T)).filter((k, i) => k !== snap.sentNotifications[i].key);
  snap.occupiedNotificationKeys = rewritten.length
    ? (await tx.sentNotification.findMany({ where: { key: { in: rewritten } }, select: { key: true } })).map((r: { key: string }) => r.key)
    : [];

  const refs: RefRow[] = [];
  for (const c of USER_REF_COLUMNS) {
    const table = delegateOf(c.model);
    const pk = pkOf(table);
    if (c.kind === "json") {
      const rows: Array<{ id: string; v: unknown }> = await tx.$queryRawUnsafe(
        `SELECT "${pk}" AS id, "${c.column}" AS v FROM "${c.model}" WHERE "${c.column}"::text LIKE $1`,
        `%${S}%`,
      );
      for (const r of rows) refs.push({ table, column: c.column, kind: c.kind, id: r.id, value: r.v });
      continue;
    }
    const where = c.kind === "array" ? { [c.column]: { has: S } } : { [c.column]: { contains: S } };
    const rows: Array<Record<string, unknown>> = await tx[table].findMany({ where, select: { [pk]: true, [c.column]: true } });
    for (const r of rows) refs.push({ table, column: c.column, kind: c.kind, id: String(r[pk]), value: r[c.column] });
  }
  snap.refs = refs;
  return snap;
}

/** Plans the merge without writing: one READ ONLY transaction. */
export async function dryRunUserMerge(
  db: Tx,
  S: string,
  T: string,
  now = new Date(),
): Promise<{ plan: MergePlan; snapshot: MergeSnapshot }> {
  return db.$transaction(
    async (tx: Tx) => {
      // Transaction-scoped: ends with this transaction. Never a session SET.
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const snapshot = await loadMergeSnapshot(tx, S, T);
      return { plan: planUserMerge(snapshot, { now }), snapshot };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

export interface ApplyUserMergeOpts {
  now?: Date;
  /** Who asked for it, when a person did. */
  actorUserId?: string | null;
  actorKind?: AttendanceActorKind;
}

export type ApplyUserMergeResult =
  | { ok: true; noop: boolean; plan: MergePlan }
  | { ok: false; plan: MergePlan };

const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v));

/** Apply the plan's ops with the client `tx`. Exported for the tests. */
export async function applyMergePlan(tx: Tx, plan: MergePlan, opts: ApplyUserMergeOpts = {}): Promise<void> {
  const { sourceId: S, targetId: T } = plan;
  for (const o of plan.ops) {
    if (o.kind === "delete") await tx[o.table].delete({ where: { [pkOf(o.table)]: o.id } });
    else if (o.kind === "update") await tx[o.table].update({ where: { [pkOf(o.table)]: o.id }, data: o.set });
    else if (o.kind === "create" && o.table === "roleChange") await recordRoleChange(tx, { ...(o.data as object), actorUserId: opts.actorUserId ?? null } as never);
    else if (o.kind === "create") await tx[o.table].create({ data: o.data });
    else if (o.kind === "event") {
      await recordAttendanceEvent(tx, o.transition as never, {
        cause: "player-merge",
        actorKind: opts.actorKind ?? "script",
        actorUserId: opts.actorUserId ?? null,
        sourceRef: `merge:${S}->${T}`,
        note: o.why,
      });
    }
  }
  const detail = jsonSafe({
    sourceId: S,
    targetId: T,
    alias: plan.alias,
    summary: summarisePlan(plan),
    conflicts: plan.conflicts,
    ops: plan.ops,
  });
  for (const orgId of plan.tombstoneOrgIds) {
    const row = await tx.userMerge.create({
      data: { oldUserId: S, survivorUserId: T, orgId, reason: USER_MERGE_REASON, actorUserId: opts.actorUserId ?? null },
      select: { id: true },
    });
    await tx.$executeRaw`UPDATE "UserMerge" SET "detail" = ${JSON.stringify(detail)}::jsonb WHERE id = ${row.id}`;
  }
}

/**
 * Merge SOURCE into TARGET in one transaction: both User rows locked, the
 * snapshot read and planned inside it, nothing written when the plan has
 * a blocker, nothing written when it is a no-op.
 */
export async function applyUserMerge(db: Tx, S: string, T: string, opts: ApplyUserMergeOpts = {}): Promise<ApplyUserMergeResult> {
  return db.$transaction(
    async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id IN (${S}, ${T}) FOR UPDATE`;
      const snapshot = await loadMergeSnapshot(tx, S, T);
      const plan = planUserMerge(snapshot, { now: opts.now ?? new Date() });
      if (plan.blockers.length > 0) return { ok: false as const, plan };
      if (plan.noop) return { ok: true as const, noop: true, plan };
      await applyMergePlan(tx, plan, opts);
      return { ok: true as const, noop: false, plan };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
