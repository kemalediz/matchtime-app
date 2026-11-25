import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const j = await db.botJob.findUnique({ where: { id: "cmtercm090000zy9k9x8hu3k3" } });
  console.log(`group post -> ${j.sentAt ? "SENT "+j.sentAt.toISOString() : "still pending"}`);
  const sn = await db.sentNotification.findFirst({ where: { key: `botjob-${j.id}` } });
  console.log(`claim row: ${sn ? "yes, waMessageId="+(sn.waMessageId ? "set (ack OK)" : "NULL") : "none"}`);
  const am = await db.analyzedMessage.count({ where: { createdAt: { gte: new Date(Date.now()-30*60000) } } });
  console.log(`AnalyzedMessage in last 30 min: ${am}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
