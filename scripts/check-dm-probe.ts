import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const j = await db.botJob.findUnique({ where: { id: "cmteg11120000dr9kqeds88aw" } });
  const age = ((Date.now()-j.createdAt.getTime())/1000).toFixed(0);
  console.log(`DM probe queued ${age}s ago -> ${j.sentAt ? "SENT "+j.sentAt.toISOString() : "STILL PENDING"}`);
  const sn = await db.sentNotification.count({ where: { key: `botjob-${j.id}` } });
  console.log(`claimed by bot: ${sn ? "YES (bot is polling)" : "NO (bot is not polling due-posts)"}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
