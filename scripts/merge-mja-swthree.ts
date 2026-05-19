/**
 * One-off: complete the MJA swthree → Michael Allen merge that
 * silently rolled back back on 2026-05-01 (FK violation on
 * RosterSurveyDM/Response, pre c4f98bc fix). Mirrors mergePlayers()
 * exactly, just runs server-side without auth.
 *
 * Idempotent: if MJA swthree no longer exists, prints + exits.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const KEEP_ID = "cmo4wnpc8001rmvr8rumvxe2l"; // Michael Allen
const DROP_ID = "cmondg8xt000104juy30ljlf3"; // MJA swthree
const ORG_ID = "cmnnwhdx30000zfr85q18lyy9"; // Sutton FC

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const [keep, drop] = await Promise.all([
    db.user.findUnique({ where: { id: KEEP_ID } }),
    db.user.findUnique({ where: { id: DROP_ID } }),
  ]);
  if (!keep) {
    console.error("Keep user not found");
    process.exit(1);
  }
  if (!drop) {
    console.log("Drop user already gone — merge already happened. Nothing to do.");
    return;
  }

  await db.$transaction(async (tx) => {
    // 1. Backfill missing fields on keep from drop.
    const patch: { phoneNumber?: string; seedRating?: number; matchRating?: number; name?: string } = {};
    if (!keep.phoneNumber && drop.phoneNumber) patch.phoneNumber = drop.phoneNumber;
    if (keep.seedRating == null && drop.seedRating != null) patch.seedRating = drop.seedRating;
    if ((!keep.matchRating || keep.matchRating === 1000) && drop.matchRating && drop.matchRating !== 1000) {
      patch.matchRating = drop.matchRating;
    }
    if (!keep.name && drop.name) patch.name = drop.name;

    // 2. Free up unique fields on drop.
    await tx.user.update({
      where: { id: DROP_ID },
      data: { phoneNumber: null, email: `merged-${DROP_ID}-${Date.now()}@matchtime.local` },
    });
    if (Object.keys(patch).length > 0) {
      await tx.user.update({ where: { id: KEEP_ID }, data: patch });
    }

    // 3. Attendance — conflict resolution by activity rank.
    const ATT_RANK = { CONFIRMED: 3, BENCH: 2, DROPPED: 1 } as const;
    const dropAtts = await tx.attendance.findMany({ where: { userId: DROP_ID } });
    for (const a of dropAtts) {
      const exists = await tx.attendance.findUnique({
        where: { matchId_userId: { matchId: a.matchId, userId: KEEP_ID } },
      });
      if (!exists) {
        await tx.attendance.update({ where: { id: a.id }, data: { userId: KEEP_ID } });
      } else {
        const dr = ATT_RANK[a.status as keyof typeof ATT_RANK] ?? 0;
        const kr = ATT_RANK[exists.status as keyof typeof ATT_RANK] ?? 0;
        if (dr > kr) {
          await tx.attendance.update({
            where: { id: exists.id },
            data: { status: a.status, position: a.position, paidAt: a.paidAt ?? exists.paidAt },
          });
        }
        await tx.attendance.delete({ where: { id: a.id } });
      }
    }

    // 4. Ratings (given + received).
    const dropGiven = await tx.rating.findMany({ where: { raterId: DROP_ID } });
    for (const r of dropGiven) {
      const exists = await tx.rating.findUnique({
        where: { matchId_raterId_playerId: { matchId: r.matchId, raterId: KEEP_ID, playerId: r.playerId } },
      });
      if (exists) await tx.rating.delete({ where: { id: r.id } });
      else await tx.rating.update({ where: { id: r.id }, data: { raterId: KEEP_ID } });
    }
    await tx.rating.updateMany({ where: { playerId: DROP_ID }, data: { playerId: KEEP_ID } });

    // 5. MoM votes.
    const dropMomGiven = await tx.moMVote.findMany({ where: { voterId: DROP_ID } });
    for (const v of dropMomGiven) {
      const exists = await tx.moMVote.findUnique({
        where: { matchId_voterId: { matchId: v.matchId, voterId: KEEP_ID } },
      });
      if (exists) await tx.moMVote.delete({ where: { id: v.id } });
      else await tx.moMVote.update({ where: { id: v.id }, data: { voterId: KEEP_ID } });
    }
    await tx.moMVote.updateMany({ where: { playerId: DROP_ID }, data: { playerId: KEEP_ID } });

    // 6. Team assignments.
    const dropTeams = await tx.teamAssignment.findMany({ where: { userId: DROP_ID } });
    for (const ta of dropTeams) {
      const exists = await tx.teamAssignment.findFirst({ where: { matchId: ta.matchId, userId: KEEP_ID } });
      if (exists) await tx.teamAssignment.delete({ where: { id: ta.id } });
      else await tx.teamAssignment.update({ where: { id: ta.id }, data: { userId: KEEP_ID } });
    }

    // 7. Per-activity positions.
    const dropPos = await tx.playerActivityPosition.findMany({ where: { userId: DROP_ID } });
    for (const pp of dropPos) {
      const exists = await tx.playerActivityPosition.findUnique({
        where: { userId_activityId: { userId: KEEP_ID, activityId: pp.activityId } },
      });
      if (exists) await tx.playerActivityPosition.delete({ where: { id: pp.id } });
      else await tx.playerActivityPosition.update({ where: { id: pp.id }, data: { userId: KEEP_ID } });
    }

    // 8. AnalyzedMessages.
    await tx.analyzedMessage.updateMany({
      where: { authorUserId: DROP_ID },
      data: { authorUserId: KEEP_ID },
    });

    // 8a. RatingAdjustment.
    const dropRA = await tx.ratingAdjustment.findMany({ where: { userId: DROP_ID } });
    for (const ra of dropRA) {
      const exists = await tx.ratingAdjustment.findUnique({
        where: { matchId_userId: { matchId: ra.matchId, userId: KEEP_ID } },
      });
      if (exists) await tx.ratingAdjustment.delete({ where: { id: ra.id } });
      else await tx.ratingAdjustment.update({ where: { id: ra.id }, data: { userId: KEEP_ID } });
    }

    // 8b. RosterSurveyDM.
    const dropDms = await tx.rosterSurveyDM.findMany({ where: { userId: DROP_ID } });
    for (const d of dropDms) {
      const exists = await tx.rosterSurveyDM.findUnique({
        where: { surveyId_userId: { surveyId: d.surveyId, userId: KEEP_ID } },
      });
      if (exists) await tx.rosterSurveyDM.delete({ where: { id: d.id } });
      else await tx.rosterSurveyDM.update({ where: { id: d.id }, data: { userId: KEEP_ID } });
    }

    // 8c. RosterSurveyResponse.
    const dropResp = await tx.rosterSurveyResponse.findMany({ where: { userId: DROP_ID } });
    for (const r of dropResp) {
      const exists = await tx.rosterSurveyResponse.findUnique({
        where: { surveyId_userId: { surveyId: r.surveyId, userId: KEEP_ID } },
      });
      if (exists) {
        if (r.classifiedAt > exists.classifiedAt) {
          await tx.rosterSurveyResponse.update({
            where: { id: exists.id },
            data: {
              response: r.response,
              rawReply: r.rawReply,
              classifiedAt: r.classifiedAt,
              adminOverride: r.adminOverride,
            },
          });
        }
        await tx.rosterSurveyResponse.delete({ where: { id: r.id } });
      } else {
        await tx.rosterSurveyResponse.update({ where: { id: r.id }, data: { userId: KEEP_ID } });
      }
    }

    // 8d. UserAlias re-attribute.
    const dropAliases = await tx.userAlias.findMany({ where: { userId: DROP_ID } });
    for (const a of dropAliases) {
      const exists = await tx.userAlias.findUnique({
        where: { orgId_alias: { orgId: a.orgId, alias: a.alias } },
      });
      if (exists && exists.userId !== KEEP_ID) await tx.userAlias.delete({ where: { id: a.id } });
      else if (exists) await tx.userAlias.delete({ where: { id: a.id } });
      else await tx.userAlias.update({ where: { id: a.id }, data: { userId: KEEP_ID } });
    }

    // 8e. Save drop's display name + email-slug as aliases for keep.
    const aliasNorm = (s: string) =>
      s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
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
    for (const alias of aliasesToSave) {
      await tx.userAlias.upsert({
        where: { orgId_alias: { orgId: ORG_ID, alias } },
        create: { orgId: ORG_ID, userId: KEEP_ID, alias, source: "merge" },
        update: { userId: KEEP_ID, source: "merge" },
      });
      console.log(`  alias saved: '${alias}' → ${keep.name}`);
    }

    // 9. Membership merge (per the new robust logic).
    const ROLE_RANK = { OWNER: 3, ADMIN: 2, PLAYER: 1 } as const;
    const dropMs = await tx.membership.findMany({ where: { userId: DROP_ID } });
    for (const dm of dropMs) {
      const km = await tx.membership.findUnique({
        where: { userId_orgId: { userId: KEEP_ID, orgId: dm.orgId } },
      });
      if (!km) {
        await tx.membership.update({ where: { id: dm.id }, data: { userId: KEEP_ID } });
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
      const newProv =
        km.provisionallyAddedAt === null || dm.provisionallyAddedAt === null
          ? null
          : km.provisionallyAddedAt < dm.provisionallyAddedAt
            ? km.provisionallyAddedAt
            : dm.provisionallyAddedAt;
      const newSeen =
        km.lastSeenInGroupAt && dm.lastSeenInGroupAt
          ? km.lastSeenInGroupAt > dm.lastSeenInGroupAt
            ? km.lastSeenInGroupAt
            : dm.lastSeenInGroupAt
          : (km.lastSeenInGroupAt ?? dm.lastSeenInGroupAt);
      await tx.membership.update({
        where: { id: km.id },
        data: {
          role: newRole,
          leftAt: newLeftAt,
          provisionallyAddedAt: newProv,
          lastSeenInGroupAt: newSeen,
        },
      });
      await tx.membership.delete({ where: { id: dm.id } });
    }

    await tx.user.delete({ where: { id: DROP_ID } });
  });

  console.log(`✓ Merged ${drop.name} → ${keep.name}.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
