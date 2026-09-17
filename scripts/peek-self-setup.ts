/**
 * READ-ONLY: what the database holds for one WhatsApp group's self-setup.
 *
 *   node --env-file=.env --import tsx scripts/peek-self-setup.ts <groupId@g.us>
 *   node --env-file=.env --import tsx scripts/peek-self-setup.ts --recent
 *
 * Prints the OnboardingSession rows for the group (stage, language,
 * captured answers), the Organisation it created (language, flags), its
 * Activity and Matches, the Memberships, the attendance on the first
 * match, and every BotJob queued for the org. Nothing is written. This
 * is the "what to check in the DB" half of the live test plan in the
 * self-setup PR (2026-09-17); `--recent` lists the sessions created in
 * the last 7 days so the group id can be found without the Pi log.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: peek-self-setup.ts <groupId@g.us> | --recent");
    process.exit(1);
  }
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  if (arg === "--recent") {
    const rows = await db.onboardingSession.findMany({
      where: { createdAt: { gt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      orderBy: { createdAt: "desc" },
      select: { whatsappGroupId: true, stage: true, language: true, groupSubject: true, createdAt: true, orgId: true },
    });
    console.table(rows);
    await db.$disconnect();
    return;
  }

  const groupId = arg;
  const sessions = await db.onboardingSession.findMany({
    where: { whatsappGroupId: groupId },
    orderBy: { createdAt: "desc" },
  });
  console.log(`\n== OnboardingSession rows for ${groupId}: ${sessions.length}`);
  for (const s of sessions) {
    console.log({
      id: s.id,
      stage: s.stage,
      language: s.language,
      source: s.source,
      groupSubject: s.groupSubject,
      groupName: s.groupName,
      addedByPhone: s.addedByPhone,
      adminUserId: s.adminUserId,
      dayOfWeek: s.dayOfWeek,
      kickoffTime: s.kickoffTime,
      venue: s.venue,
      playersPerSide: s.playersPerSide,
      recurrence: s.recurrence,
      selectedFeatures: s.selectedFeatures,
      participants: Array.isArray(s.participants) ? (s.participants as unknown[]).length : 0,
      capturedHistory: Array.isArray(s.capturedHistory) ? (s.capturedHistory as unknown[]).length : 0,
      orgId: s.orgId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
  }

  const orgs = await db.organisation.findMany({
    where: { whatsappGroupId: groupId },
    include: {
      activities: { include: { matches: { orderBy: { date: "asc" }, include: { attendances: { include: { user: { select: { name: true, phoneNumber: true } } } } } } } },
      memberships: { include: { user: { select: { name: true, phoneNumber: true } } } },
    },
  });
  console.log(`\n== Organisation rows for ${groupId}: ${orgs.length}`);
  for (const o of orgs) {
    console.log({
      id: o.id,
      name: o.name,
      slug: o.slug,
      language: o.language,
      whatsappBotEnabled: o.whatsappBotEnabled,
      featureAttendance: o.featureAttendance,
      featureBench: o.featureBench,
      featureTeamBalancing: o.featureTeamBalancing,
      featureMomVoting: o.featureMomVoting,
      featurePlayerRating: o.featurePlayerRating,
      featureReminders: o.featureReminders,
      paymentTrackingEnabled: o.paymentTrackingEnabled,
      createdAt: o.createdAt,
    });
    console.log("  memberships:");
    for (const m of o.memberships) {
      console.log(`    ${m.role.padEnd(6)} ${m.user.name ?? "(no name)"} ${m.user.phoneNumber ?? "(no phone)"} leftAt=${m.leftAt?.toISOString() ?? "-"}`);
    }
    for (const a of o.activities) {
      console.log(`  activity ${a.id}: ${a.name} dow=${a.dayOfWeek} time=${a.time} venue=${a.venue} active=${a.isActive}`);
      for (const mt of a.matches) {
        console.log(`    match ${mt.id}: ${mt.date.toISOString()} status=${mt.status} max=${mt.maxPlayers}`);
        for (const at of mt.attendances) {
          console.log(`      ${at.status.padEnd(9)} ${at.user.name ?? "(no name)"} ${at.user.phoneNumber ?? ""}`);
        }
      }
    }
    const jobs = await db.botJob.findMany({ where: { orgId: o.id }, orderBy: { createdAt: "asc" } });
    console.log(`  botJobs: ${jobs.length}`);
    for (const j of jobs) {
      console.log(`    ${j.kind} to=${j.phone ?? "group"} sent=${j.sentAt?.toISOString() ?? "-"} :: ${j.text.slice(0, 90).replace(/\n/g, " ")}`);
    }
    const intro = await db.sentNotification.findUnique({ where: { key: `org-${o.id}:bot-intro` } });
    console.log(`  scheduler intro suppressed: ${intro ? "yes (row present)" : "NO, the scheduler will post its own intro"}`);
  }
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
