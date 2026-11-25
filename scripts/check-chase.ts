import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const since = new Date(Date.now()-10*60000);
  const jobs = await db.botJob.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  const sent = jobs.filter((j:any)=>j.sentAt).length;
  console.log(`BotJobs last 10 min: ${jobs.length}  sent: ${sent}  pending: ${jobs.length-sent}`);
  for (const j of jobs.slice(0,4)) console.log(`  ${j.kind} ${j.sentAt ? "SENT" : "pending"} "${(j.text??"").slice(0,45).replace(/\n/g," ")}"`);
  const sn = await db.sentNotification.count({ where: { createdAt: { gte: since } } });
  console.log(`SentNotification rows last 10 min: ${sn}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
