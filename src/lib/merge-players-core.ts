/**
 * Core merge logic for two duplicate User rows.
 *
 * Lifted out of `src/app/actions/players.ts:mergePlayers` (2026-05-25)
 * so the same code path can run from BOTH the admin server-action
 * (which adds auth + revalidatePath wrappers) AND from one-shot
 * migration scripts (which run unauthenticated).
 *
 * The transactional body is unchanged — same conflict-resolution rules
 * across Attendance / Rating / MoMVote / TeamAssignment /
 * PlayerActivityPosition / RatingAdjustment / RosterSurveyDM /
 * RosterSurveyResponse / UserAlias / Membership.
 *
 * Returns nothing — throws on failure. Idempotent in the trivial sense:
 * re-running over an already-merged pair will fail to find the drop
 * user and throw, which is fine for a script's loop.
 */
// We deliberately type `tx` loosely — the Prisma transaction client
// type changes shape when wrapped by `$extends` (see src/lib/db.ts).
// The methods we call (user, attendance, etc.) are present on both
// the base and the extended client, so `any` here is safe + portable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxClient = any;

const ATT_RANK = { CONFIRMED: 3, BENCH: 2, DROPPED: 1 } as const;
const ROLE_RANK = { OWNER: 3, ADMIN: 2, PLAYER: 1 } as const;

function aliasNorm(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export interface MergePlayersCoreOpts {
  /** Org IDs whose UserAlias table should receive the dropped user's
   *  name / email-slug as an alias for the keeper. Empty array → skip
   *  alias save (e.g. global merge with no specific scope). For the
   *  admin action this is `[adminOrgId]`; for migration it's the
   *  intersection of both users' memberships. */
  saveAliasInOrgIds: string[];
}

export async function mergePlayersCore(
  tx: TxClient,
  keepUserId: string,
  dropUserId: string,
  opts: MergePlayersCoreOpts,
): Promise<void> {
  if (keepUserId === dropUserId) throw new Error("Pick two different players");

  const [keep, drop] = await Promise.all([
    tx.user.findUnique({ where: { id: keepUserId } }),
    tx.user.findUnique({ where: { id: dropUserId } }),
  ]);
  if (!keep || !drop) throw new Error("Player not found");

  // 1. Backfill missing fields on `keep` from `drop`.
  const patch: { phoneNumber?: string; seedRating?: number; matchRating?: number; name?: string } = {};
  if (!keep.phoneNumber && drop.phoneNumber) patch.phoneNumber = drop.phoneNumber;
  if (keep.seedRating == null && drop.seedRating != null) patch.seedRating = drop.seedRating;
  if ((!keep.matchRating || keep.matchRating === 1000) && drop.matchRating && drop.matchRating !== 1000) {
    patch.matchRating = drop.matchRating;
  }
  if (!keep.name && drop.name) patch.name = drop.name;

  // 2. Free up unique fields on `drop` so `keep` can take them.
  await tx.user.update({
    where: { id: dropUserId },
    data: { phoneNumber: null, email: `merged-${dropUserId}-${Date.now()}@matchtime.local` },
  });
  if (Object.keys(patch).length > 0) {
    await tx.user.update({ where: { id: keepUserId }, data: patch });
  }

  // 3. Attendance — CONFIRMED > BENCH > DROPPED on collision.
  const dropAtts = await tx.attendance.findMany({ where: { userId: dropUserId } });
  for (const a of dropAtts) {
    const existing = await tx.attendance.findUnique({
      where: { matchId_userId: { matchId: a.matchId, userId: keepUserId } },
    });
    if (!existing) {
      await tx.attendance.update({ where: { id: a.id }, data: { userId: keepUserId } });
    } else {
      const dropRank = ATT_RANK[a.status as keyof typeof ATT_RANK] ?? 0;
      const keepRank = ATT_RANK[existing.status as keyof typeof ATT_RANK] ?? 0;
      if (dropRank > keepRank) {
        await tx.attendance.update({
          where: { id: existing.id },
          data: { status: a.status, position: a.position, paidAt: a.paidAt ?? existing.paidAt },
        });
      }
      await tx.attendance.delete({ where: { id: a.id } });
    }
  }

  // 4. Rating — (matchId, raterId, playerId) unique.
  const dropGiven = await tx.rating.findMany({ where: { raterId: dropUserId } });
  for (const r of dropGiven) {
    const exists = await tx.rating.findUnique({
      where: { matchId_raterId_playerId: { matchId: r.matchId, raterId: keepUserId, playerId: r.playerId } },
    });
    if (exists) await tx.rating.delete({ where: { id: r.id } });
    else await tx.rating.update({ where: { id: r.id }, data: { raterId: keepUserId } });
  }
  await tx.rating.updateMany({ where: { playerId: dropUserId }, data: { playerId: keepUserId } });

  // 5. MoMVote — (matchId, voterId) unique.
  const droppedMomGiven = await tx.moMVote.findMany({ where: { voterId: dropUserId } });
  for (const v of droppedMomGiven) {
    const exists = await tx.moMVote.findUnique({
      where: { matchId_voterId: { matchId: v.matchId, voterId: keepUserId } },
    });
    if (exists) await tx.moMVote.delete({ where: { id: v.id } });
    else await tx.moMVote.update({ where: { id: v.id }, data: { voterId: keepUserId } });
  }
  await tx.moMVote.updateMany({ where: { playerId: dropUserId }, data: { playerId: keepUserId } });

  // 6. TeamAssignment — (matchId, userId) unique (via findFirst).
  const dropTeams = await tx.teamAssignment.findMany({ where: { userId: dropUserId } });
  for (const ta of dropTeams) {
    const exists = await tx.teamAssignment.findFirst({ where: { matchId: ta.matchId, userId: keepUserId } });
    if (exists) await tx.teamAssignment.delete({ where: { id: ta.id } });
    else await tx.teamAssignment.update({ where: { id: ta.id }, data: { userId: keepUserId } });
  }

  // 7. PlayerActivityPosition.
  const dropPositions = await tx.playerActivityPosition.findMany({ where: { userId: dropUserId } });
  for (const pp of dropPositions) {
    const exists = await tx.playerActivityPosition.findUnique({
      where: { userId_activityId: { userId: keepUserId, activityId: pp.activityId } },
    });
    if (exists) await tx.playerActivityPosition.delete({ where: { id: pp.id } });
    else await tx.playerActivityPosition.update({ where: { id: pp.id }, data: { userId: keepUserId } });
  }

  // 8. AnalyzedMessage.
  await tx.analyzedMessage.updateMany({
    where: { authorUserId: dropUserId },
    data: { authorUserId: keepUserId },
  });

  // 8a. RatingAdjustment.
  const dropRatingAdjs = await tx.ratingAdjustment.findMany({ where: { userId: dropUserId } });
  for (const ra of dropRatingAdjs) {
    const exists = await tx.ratingAdjustment.findUnique({
      where: { matchId_userId: { matchId: ra.matchId, userId: keepUserId } },
    });
    if (exists) await tx.ratingAdjustment.delete({ where: { id: ra.id } });
    else await tx.ratingAdjustment.update({ where: { id: ra.id }, data: { userId: keepUserId } });
  }

  // 8b. RosterSurveyDM.
  const dropDms = await tx.rosterSurveyDM.findMany({ where: { userId: dropUserId } });
  for (const d of dropDms) {
    const exists = await tx.rosterSurveyDM.findUnique({
      where: { surveyId_userId: { surveyId: d.surveyId, userId: keepUserId } },
    });
    if (exists) await tx.rosterSurveyDM.delete({ where: { id: d.id } });
    else await tx.rosterSurveyDM.update({ where: { id: d.id }, data: { userId: keepUserId } });
  }

  // 8c. RosterSurveyResponse — prefer most recent classifiedAt on collision.
  const dropResponses = await tx.rosterSurveyResponse.findMany({ where: { userId: dropUserId } });
  for (const r of dropResponses) {
    const exists = await tx.rosterSurveyResponse.findUnique({
      where: { surveyId_userId: { surveyId: r.surveyId, userId: keepUserId } },
    });
    if (exists) {
      if (r.classifiedAt > exists.classifiedAt) {
        await tx.rosterSurveyResponse.update({
          where: { id: exists.id },
          data: { response: r.response, rawReply: r.rawReply, classifiedAt: r.classifiedAt, adminOverride: r.adminOverride },
        });
      }
      await tx.rosterSurveyResponse.delete({ where: { id: r.id } });
    } else {
      await tx.rosterSurveyResponse.update({ where: { id: r.id }, data: { userId: keepUserId } });
    }
  }

  // 8d. UserAlias — re-point to keep, dedupe on collision.
  const dropAliases = await tx.userAlias.findMany({ where: { userId: dropUserId } });
  for (const a of dropAliases) {
    const exists = await tx.userAlias.findUnique({
      where: { orgId_alias: { orgId: a.orgId, alias: a.alias } },
    });
    if (exists && exists.userId !== keepUserId) await tx.userAlias.delete({ where: { id: a.id } });
    else if (exists && exists.userId === keepUserId) await tx.userAlias.delete({ where: { id: a.id } });
    else await tx.userAlias.update({ where: { id: a.id }, data: { userId: keepUserId } });
  }

  // 8e. Save dropped name + email-slug as alias for keeper, in the
  //     requested org(s). Empty array → skip.
  if (opts.saveAliasInOrgIds.length > 0) {
    const aliasesToSave = new Set<string>();
    if (drop.name) {
      const k = aliasNorm(drop.name);
      if (k.length >= 2) aliasesToSave.add(k);
    }
    if (drop.email) {
      const m = drop.email.match(/^provisional\+([a-z0-9-]+)-[a-z0-9]+@/i);
      if (m) {
        const k = aliasNorm(m[1].replace(/-/g, " "));
        if (k.length >= 2) aliasesToSave.add(k);
      }
    }
    for (const orgId of opts.saveAliasInOrgIds) {
      for (const alias of aliasesToSave) {
        await tx.userAlias.upsert({
          where: { orgId_alias: { orgId, alias } },
          create: { orgId, userId: keepUserId, alias, source: "merge" },
          update: { userId: keepUserId, source: "merge" },
        });
      }
    }
  }

  // 9. Membership — merge per org, drop's row deleted.
  const dropMemberships = await tx.membership.findMany({ where: { userId: dropUserId } });
  for (const dm of dropMemberships) {
    const km = await tx.membership.findUnique({
      where: { userId_orgId: { userId: keepUserId, orgId: dm.orgId } },
    });
    if (!km) {
      await tx.membership.update({ where: { id: dm.id }, data: { userId: keepUserId } });
      continue;
    }
    const newRole =
      (ROLE_RANK[dm.role as keyof typeof ROLE_RANK] ?? 0) >
      (ROLE_RANK[km.role as keyof typeof ROLE_RANK] ?? 0)
        ? dm.role
        : km.role;
    const newLeftAt =
      km.leftAt === null || dm.leftAt === null
        ? null
        : km.leftAt > dm.leftAt
          ? km.leftAt
          : dm.leftAt;
    const newProvisional =
      km.provisionallyAddedAt === null || dm.provisionallyAddedAt === null
        ? null
        : km.provisionallyAddedAt < dm.provisionallyAddedAt
          ? km.provisionallyAddedAt
          : dm.provisionallyAddedAt;
    const newLastSeen =
      km.lastSeenInGroupAt && dm.lastSeenInGroupAt
        ? km.lastSeenInGroupAt > dm.lastSeenInGroupAt
          ? km.lastSeenInGroupAt
          : dm.lastSeenInGroupAt
        : (km.lastSeenInGroupAt ?? dm.lastSeenInGroupAt);
    await tx.membership.update({
      where: { id: km.id },
      data: { role: newRole, leftAt: newLeftAt, provisionallyAddedAt: newProvisional, lastSeenInGroupAt: newLastSeen },
    });
    await tx.membership.delete({ where: { id: dm.id } });
  }

  await tx.user.delete({ where: { id: dropUserId } });
}
