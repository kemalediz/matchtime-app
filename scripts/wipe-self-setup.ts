/**
 * Tear down a throwaway self-setup: the OnboardingSession rows for one
 * WhatsApp group and, if the setup completed, the Organisation it
 * created (via the same deletes scripts/wipe-org.ts makes).
 *
 * DRY RUN by default. Pass --apply to delete.
 *
 *   node --env-file=.env --import tsx scripts/wipe-self-setup.ts <groupId@g.us>
 *   node --env-file=.env --import tsx scripts/wipe-self-setup.ts <groupId@g.us> --apply
 *
 * Refuses to touch an org whose group id is not the one given, and
 * refuses any org that has more than one Activity or any COMPLETED
 * match (a throwaway test org has neither), so it cannot be pointed at a
 * real club by mistake. wipe-org.ts remains the tool for a real org.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const groupId = args.find((a) => !a.startsWith("--"));
  if (!groupId || !groupId.endsWith("@g.us")) {
    console.error("usage: wipe-self-setup.ts <groupId@g.us> [--apply]");
    process.exit(1);
  }
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const sessions = await db.onboardingSession.findMany({ where: { whatsappGroupId: groupId }, select: { id: true, stage: true } });
  const orgs = await db.organisation.findMany({
    where: { whatsappGroupId: groupId },
    include: { activities: { include: { matches: { select: { id: true, status: true } } } }, memberships: { select: { userId: true } } },
  });
  console.log(`${apply ? "APPLY" : "DRY RUN"}: group ${groupId}`);
  console.log(`  OnboardingSession rows: ${sessions.length} (${sessions.map((s) => s.stage).join(", ") || "none"})`);
  for (const o of orgs) {
    const matches = o.activities.flatMap((a) => a.matches);
    console.log(`  Organisation ${o.id} "${o.name}" (${o.slug}): ${o.activities.length} activity, ${matches.length} match, ${o.memberships.length} memberships`);
    if (o.activities.length > 1 || matches.some((m) => m.status === "COMPLETED")) {
      console.error("  REFUSING: this does not look like a throwaway setup (more than one activity or a completed match). Use scripts/wipe-org.ts.");
      process.exit(2);
    }
  }
  if (!apply) {
    console.log("nothing deleted (pass --apply)");
    await db.$disconnect();
    return;
  }

  for (const o of orgs) {
    const matchIds = o.activities.flatMap((a) => a.matches.map((m) => m.id));
    await db.$transaction([
      db.attendance.deleteMany({ where: { matchId: { in: matchIds } } }),
      db.teamAssignment.deleteMany({ where: { matchId: { in: matchIds } } }),
      db.sentNotification.deleteMany({ where: { OR: [{ matchId: { in: matchIds } }, { key: { startsWith: `org-${o.id}:` } }] } }),
      db.botJob.deleteMany({ where: { orgId: o.id } }),
      db.analyzedMessage.deleteMany({ where: { orgId: o.id } }),
      db.match.deleteMany({ where: { id: { in: matchIds } } }),
      db.activity.deleteMany({ where: { orgId: o.id } }),
      db.membership.deleteMany({ where: { orgId: o.id } }),
      db.sport.deleteMany({ where: { orgId: o.id } }),
      db.organisation.delete({ where: { id: o.id } }),
    ]);
    console.log(`  deleted org ${o.id}`);
    // Placeholder users the setup created for this org's members, if no
    // other org knows them.
    const orphans = await db.user.findMany({
      where: { id: { in: o.memberships.map((m) => m.userId) }, email: { endsWith: "@placeholder.matchtime" }, memberships: { none: {} } },
      select: { id: true },
    });
    if (orphans.length) {
      await db.user.deleteMany({ where: { id: { in: orphans.map((u) => u.id) } } });
      console.log(`  deleted ${orphans.length} placeholder user(s)`);
    }
  }
  const del = await db.onboardingSession.deleteMany({ where: { whatsappGroupId: groupId } });
  console.log(`  deleted ${del.count} OnboardingSession row(s)`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
