import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const j = await db.botJob.findUnique({ where: { id: "cmtefzy3y0000ba9kn4jimxt6" } });
  const ageSec = ((Date.now() - j.createdAt.getTime())/1000).toFixed(0);
  console.log(`queued ${ageSec}s ago -> sentAt = ${j.sentAt ? j.sentAt.toISOString() : "STILL PENDING"}`);
  const sn = await db.sentNotification.findMany({ where: { key: `botjob-${j.id}` } });
  console.log(`claim row: ${sn.length ? "EXISTS (bot polled + claimed it)" : "NONE (bot never polled due-posts)"}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
