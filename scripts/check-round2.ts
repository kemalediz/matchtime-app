import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const since = new Date(Date.now()-12*60000);
  const jobs = await db.botJob.findMany({ where: { createdAt: { gte: since }, kind: "dm" }, orderBy: { createdAt: "asc" } });
  console.log(`new DM jobs: ${jobs.length}  sent: ${jobs.filter((j:any)=>j.sentAt).length}`);
  if (jobs[0]) console.log(`\n--- as delivered ---\n${jobs[0].text}\n`);
  for (const j of jobs) console.log(`  ${j.sentAt ? "SENT   " : "pending"} ${j.phone}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
