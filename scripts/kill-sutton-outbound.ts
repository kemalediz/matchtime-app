import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const APPLY = process.argv.includes("--apply");
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  if (!org) throw new Error("no sutton-fc org");
  console.log(`Org: ${org.name}  botEnabled=${org.whatsappBotEnabled}`);

  const pending = await db.botJob.findMany({ where: { orgId: org.id, sentAt: null }, orderBy: { createdAt: "asc" } });
  const sentLastHr = await db.botJob.count({ where: { orgId: org.id, sentAt: { gte: new Date(Date.now() - 60*60*1000) } } });
  const sentLast24 = await db.botJob.count({ where: { orgId: org.id, sentAt: { gte: new Date(Date.now() - 24*60*60*1000) } } });
  console.log(`PENDING (unsent) BotJobs: ${pending.length}`);
  console.log(`SENT last hour: ${sentLastHr}   last 24h: ${sentLast24}`);
  for (const j of pending.slice(0, 25)) {
    console.log(`  [pending ${j.createdAt.toISOString()}] kind=${j.kind} phone=${j.phone ?? "-"} "${(j.text ?? "").slice(0,80).replace(/\n/g," ")}"`);
  }
  if (!APPLY) { console.log("\n(dry-run — pass --apply to DISABLE bot + delete pending jobs)"); await db.$disconnect(); return; }

  const del = await db.botJob.deleteMany({ where: { orgId: org.id, sentAt: null } });
  await db.organisation.update({ where: { id: org.id }, data: { whatsappBotEnabled: false } });
  console.log(`\nSTOPPED: deleted ${del.count} pending job(s); whatsappBotEnabled=false for ${org.name}.`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
