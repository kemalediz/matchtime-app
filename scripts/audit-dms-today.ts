import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const start = new Date(); start.setHours(0,0,0,0);
  const jobs = await db.botJob.findMany({ where: { createdAt: { gte: start } }, orderBy: { createdAt: "asc" } });
  console.log(`BotJobs today: ${jobs.length}`);
  const byHour: Record<string, {dm:number;group:number}> = {};
  for (const j of jobs) {
    const h = j.createdAt.toLocaleTimeString("en-GB",{timeZone:"Europe/London",hour:"2-digit"});
    (byHour[h] ??= {dm:0,group:0});
    if (j.kind === "dm") byHour[h].dm++; else byHour[h].group++;
  }
  for (const [h,v] of Object.entries(byHour)) console.log(`  ${h}:00 -> ${v.dm} DMs, ${v.group} group`);
  const recruit = await db.sentNotification.count({ where: { kind: "recruit-dm", createdAt: { gte: start } } });
  console.log(`\nrecruit-dm SentNotifications today: ${recruit}`);
  const uniq = new Set(jobs.filter((j:any)=>j.kind==="dm").map((j:any)=>j.phone));
  console.log(`distinct phones DM'd today: ${uniq.size}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
