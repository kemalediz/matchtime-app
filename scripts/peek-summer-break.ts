import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  console.log(`Org: ${org.name}  botEnabled=${org.whatsappBotEnabled}`);

  const acts = await db.activity.findMany({ where: { orgId: org.id }, select: { id: true, name: true, isActive: true, dayOfWeek: true, time: true } });
  console.log("\n=== Activities (isActive=true => weekly cron generates matches) ===");
  for (const a of acts) console.log(`  ${a.isActive ? "ACTIVE " : "off    "} ${a.id}  ${a.name}  day=${a.dayOfWeek} ${a.time}`);

  const matches = await db.match.findMany({
    where: { activity: { orgId: org.id }, status: { in: ["UPCOMING","TEAMS_GENERATED","TEAMS_PUBLISHED"] } },
    include: { activity: { select: { name: true } }, _count: { select: { attendances: true } } },
    orderBy: { date: "asc" },
  });
  console.log(`\n=== Upcoming matches (these would trigger posts): ${matches.length} ===`);
  for (const m of matches) console.log(`  ${m.id}  ${m.activity.name}  ${m.date.toISOString()}  status=${m.status}  attendances=${m._count.attendances}`);

  const unpaid = await db.attendance.count({ where: { match: { activity: { orgId: org.id } }, paidAt: null, status: "CONFIRMED" } });
  console.log(`\nConfirmed attendances with paidAt=null (possible payment chases): ${unpaid}`);

  const pendingJobs = await db.botJob.count({ where: { orgId: org.id, sentAt: null } });
  console.log(`Pending BotJobs: ${pendingJobs}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
