import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  for (const h of [1, 6, 24, 72]) {
    const n = await db.analyzedMessage.count({ where: { createdAt: { gte: new Date(Date.now() - h*3600*1000) } } });
    console.log(`AnalyzedMessage last ${h}h: ${n}`);
  }
  const last = await db.analyzedMessage.findMany({ orderBy: { createdAt: "desc" }, take: 15 });
  console.log("\n--- most recent analyzed ---");
  for (const r of last) {
    console.log(`${r.createdAt.toISOString()} by=${r.handledBy} intent=${r.intent} author=${r.authorName ?? "?"} "${(r.body ?? "").slice(0,60).replace(/\n/g," ")}"`);
  }
  console.log("\n--- most recent BotJobs (any state) ---");
  const jobs = await db.botJob.findMany({ orderBy: { createdAt: "desc" }, take: 15 });
  for (const j of jobs) {
    console.log(`${j.createdAt.toISOString()} kind=${j.kind} sent=${j.sentAt ? j.sentAt.toISOString() : "PENDING"} "${(j.text ?? "").slice(0,60).replace(/\n/g," ")}"`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
