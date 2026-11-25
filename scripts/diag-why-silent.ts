import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const now = new Date();
  console.log(`NOW: ${now.toISOString()}  London=${now.toLocaleString("en-GB",{timeZone:"Europe/London"})}`);

  const m = await db.match.findFirst({
    where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" },
    include: { activity: true },
  });
  console.log(`\nMATCH ${m.id}`);
  console.log(`  date            = ${m.date.toISOString()}  (London ${m.date.toLocaleString("en-GB",{timeZone:"Europe/London"})})`);
  console.log(`  attendanceDeadline = ${m.attendanceDeadline.toISOString()} (London ${m.attendanceDeadline.toLocaleString("en-GB",{timeZone:"Europe/London"})})`);
  console.log(`  deadlineHours on activity = ${m.activity.deadlineHours}`);
  console.log(`  >>> beforeDeadline (now < deadline) = ${now < m.attendanceDeadline}   <-- gates the 17:00 evening update`);
  const hoursUntil = (m.date.getTime()-now.getTime())/36e5;
  console.log(`  hoursUntilMatch = ${hoursUntil.toFixed(1)}  (announce needs >24)`);

  console.log(`\n=== SentNotification, last 5 days ===`);
  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: new Date(Date.now()-5*864e5) } }, orderBy: { createdAt: "asc" } });
  for (const s of sn) console.log(`  ${s.createdAt.toLocaleString("en-GB",{timeZone:"Europe/London"})} ${s.kind} ${s.key.slice(0,55)}`);
  if (!sn.length) console.log("  (none)");

  console.log(`\n=== AnalyzedMessage, last 5 days ===`);
  const am = await db.analyzedMessage.count({ where: { createdAt: { gte: new Date(Date.now()-5*864e5) } } });
  console.log(`  count = ${am}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
