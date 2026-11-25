import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const since = new Date(Date.now() - 7*24*3600*1000);

  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  const jobs = await db.botJob.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });

  const day = (d: Date) => d.toISOString().slice(0,10);
  const agg: Record<string, Record<string, number>> = {};
  for (const s of sn) { const k = day(s.createdAt); (agg[k] ??= {})[`SN:${s.kind}`] = ((agg[k] ??= {})[`SN:${s.kind}`] ?? 0) + 1; }
  for (const j of jobs) { const k = day(j.createdAt); (agg[k] ??= {})[`JOB:${j.kind}`] = ((agg[k] ??= {})[`JOB:${j.kind}`] ?? 0) + 1; }

  console.log("=== outbound volume by day (last 7d) ===");
  for (const k of Object.keys(agg).sort()) {
    const row = agg[k];
    const total = Object.values(row).reduce((a,b)=>a+b,0);
    console.log(`${k}  TOTAL=${total}  ${JSON.stringify(row)}`);
  }
  console.log(`\nTotals: SentNotification=${sn.length}  BotJobs=${jobs.length}`);

  console.log("\n=== group-message SentNotifications (what the GROUP saw) ===");
  for (const s of sn.filter((x:any)=>x.kind === "group-message")) {
    console.log(`  ${s.createdAt.toISOString()}  ${s.key.slice(0,80)}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
