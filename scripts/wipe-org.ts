/**
 * Generic org-wipe script.
 *
 * Permanently deletes an organisation and everything attached:
 * activities, matches, attendances, teams, ratings, MoM votes, sent
 * notifications, bench confirmations, rating adjustments, sports,
 * memberships, bot jobs, analyzed messages — and any orphaned
 * synthetic users (onboarding+*, provisional+*, wa-*).
 *
 * Defaults to a DRY RUN. Pass --apply to actually delete.
 *
 *   # List all orgs:
 *   node --env-file=.env --import tsx scripts/wipe-org.ts --list
 *
 *   # Dry-run (shows what would be deleted):
 *   node --env-file=.env --import tsx scripts/wipe-org.ts <slug-or-id>
 *
 *   # Apply:
 *   node --env-file=.env --import tsx scripts/wipe-org.ts <slug-or-id> --apply
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const list = args.includes("--list");
  const target = args.find((a) => !a.startsWith("--"));

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  if (list) {
    const orgs = await db.organisation.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            memberships: { where: { leftAt: null } },
            activities: true,
          },
        },
      },
    });
    console.log(`\nOrganisations (${orgs.length}):\n`);
    for (const o of orgs) {
      console.log(
        `  ${o.slug.padEnd(28)} ${o.name.padEnd(32)} members=${o._count.memberships} activities=${o._count.activities}  created=${o.createdAt.toISOString().slice(0, 10)}  id=${o.id}`,
      );
    }
    console.log("");
    return;
  }

  if (!target) {
    console.error("Usage: wipe-org.ts <slug-or-id> [--apply]");
    console.error("       wipe-org.ts --list");
    process.exit(1);
  }

  const org = await db.organisation.findFirst({
    where: { OR: [{ slug: target }, { id: target }] },
    select: { id: true, name: true, slug: true, whatsappGroupId: true },
  });
  if (!org) {
    console.error(`No org found matching "${target}"`);
    process.exit(1);
  }

  const activities = await db.activity.findMany({
    where: { orgId: org.id },
    select: { id: true },
  });
  const activityIds = activities.map((a) => a.id);
  const matches = await db.match.findMany({
    where: { activityId: { in: activityIds } },
    select: { id: true },
  });
  const matchIds = matches.map((m) => m.id);

  const [
    attendances,
    teamAssignments,
    ratings,
    momVotes,
    sentNotifications,
    benchConfirmations,
    ratingAdjustments,
    sports,
    memberships,
    botJobs,
    analyzedMessages,
  ] = await Promise.all([
    db.attendance.count({ where: { matchId: { in: matchIds } } }),
    db.teamAssignment.count({ where: { matchId: { in: matchIds } } }),
    db.rating.count({ where: { matchId: { in: matchIds } } }),
    db.moMVote.count({ where: { matchId: { in: matchIds } } }),
    db.sentNotification.count({ where: { matchId: { in: matchIds } } }),
    db.pendingBenchConfirmation.count({ where: { matchId: { in: matchIds } } }),
    db.ratingAdjustment.count({ where: { matchId: { in: matchIds } } }),
    db.sport.count({ where: { orgId: org.id } }),
    db.membership.count({ where: { orgId: org.id } }),
    db.botJob.count({ where: { orgId: org.id } }),
    db.analyzedMessage.count({ where: { orgId: org.id } }),
  ]);

  // Synthetic-user orphans.
  const memberUsers = await db.membership.findMany({
    where: { orgId: org.id },
    select: { userId: true, user: { select: { email: true, name: true } } },
  });
  let syntheticOrphans = 0;
  const orphanIds: string[] = [];
  for (const m of memberUsers) {
    const email = m.user.email ?? "";
    const isSynthetic =
      email.startsWith("onboarding+") ||
      email.startsWith("provisional+") ||
      email.startsWith("wa-");
    if (!isSynthetic) continue;
    const otherCount = await db.membership.count({
      where: { userId: m.userId, orgId: { not: org.id } },
    });
    if (otherCount === 0) {
      syntheticOrphans += 1;
      orphanIds.push(m.userId);
    }
  }

  console.log(`\nWipe plan for "${org.name}" (${org.slug}, id=${org.id}):\n`);
  console.log(`  activities          ${activities.length}`);
  console.log(`  matches             ${matches.length}`);
  console.log(`  attendances         ${attendances}`);
  console.log(`  teamAssignments     ${teamAssignments}`);
  console.log(`  ratings             ${ratings}`);
  console.log(`  momVotes            ${momVotes}`);
  console.log(`  sentNotifications   ${sentNotifications}`);
  console.log(`  benchConfirmations  ${benchConfirmations}`);
  console.log(`  ratingAdjustments   ${ratingAdjustments}`);
  console.log(`  sports              ${sports}`);
  console.log(`  memberships         ${memberships}`);
  console.log(`  botJobs             ${botJobs}`);
  console.log(`  analyzedMessages    ${analyzedMessages}`);
  console.log(`  syntheticOrphans    ${syntheticOrphans}`);
  console.log("");

  if (!apply) {
    console.log("Dry run. Pass --apply to actually delete.\n");
    return;
  }

  await db.$transaction(
    async (tx) => {
      if (matchIds.length > 0) {
        await tx.match.deleteMany({ where: { id: { in: matchIds } } });
      }
      if (activityIds.length > 0) {
        await tx.activity.deleteMany({ where: { orgId: org.id } });
      }
      await tx.botJob.deleteMany({ where: { orgId: org.id } });
      await tx.analyzedMessage.deleteMany({ where: { orgId: org.id } });
      // Phase 2: onboarding sessions are keyed by whatsappGroupId
      // (orgId is only filled mid-flow), so clear by group too.
      await tx.onboardingSession.deleteMany({
        where: {
          OR: [
            { orgId: org.id },
            ...(org.whatsappGroupId ? [{ whatsappGroupId: org.whatsappGroupId }] : []),
          ],
        },
      });
      await tx.sport.deleteMany({ where: { orgId: org.id } });
      await tx.organisation.delete({ where: { id: org.id } });
      if (orphanIds.length > 0) {
        await tx.user.deleteMany({ where: { id: { in: orphanIds } } });
      }
    },
    { timeout: 60_000 },
  );

  console.log(`Deleted org "${org.name}" and all attached data.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
