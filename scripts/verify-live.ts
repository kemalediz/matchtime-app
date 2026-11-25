import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { isNextUpcomingForPosting } from "../src/lib/next-upcoming-match.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });

  const ms = await db.match.findMany({
    where: { activity: { orgId: org.id }, isHistorical: false,
             status: { in: ["UPCOMING","TEAMS_GENERATED","TEAMS_PUBLISHED"] } },
    include: { activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
    orderBy: { date: "asc" },
  });
  const sib = ms.map((m: any) => ({ id: m.id, activityId: m.activityId, date: m.date, status: m.status,
                                    isHistorical: m.isHistorical, activity: m.activity }));
  console.log(`Live matches: ${ms.length}`);
  let postable = 0;
  for (const m of sib) {
    const ok = isNextUpcomingForPosting(sib, m as any);
    if (ok) postable++;
    const lon = m.date.toLocaleString("en-GB", { timeZone: "Europe/London", day:"2-digit", month:"short", year:"numeric" });
    if (ok || sib.indexOf(m) < 3) console.log(`  ${lon}  postable=${ok ? "YES <-- announces" : "no (silent)"}`);
  }
  console.log(`\nPOSTABLE COUNT = ${postable}  (must be exactly 1)`);

  const since = new Date(Date.now() - 60*60*1000);
  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  console.log(`\nSentNotification in last hour: ${sn.length}`);
  for (const s of sn) console.log(`  ${s.createdAt.toISOString()} ${s.kind} ${s.key.slice(0,60)}`);
  const jobs = await db.botJob.count({ where: { orgId: org.id, sentAt: null } });
  console.log(`Pending BotJobs: ${jobs}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
