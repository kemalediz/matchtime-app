import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const APPLY = process.argv.includes("--apply");
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });

  console.log("PLAN (summer break until 23 Aug 2026):");
  console.log("  1. tuesday-7aside.isActive -> false   (stops the weekly cron generating new matches)");
  console.log("  2. match cmrjvyy6b (21 Jul) -> CANCELLED, set directly in DB so NO announcement is posted");
  console.log("  3. whatsappBotEnabled stays FALSE     (guarantees zero group messages)");

  if (!APPLY) { console.log("\n(dry-run — pass --apply)"); await db.$disconnect(); return; }

  await db.activity.update({ where: { id: "tuesday-7aside" }, data: { isActive: false } });
  await db.match.update({ where: { id: "cmrjvyy6b000p04jip1ges3y6" }, data: { status: "CANCELLED" } });

  const acts = await db.activity.findMany({ where: { orgId: org.id }, select: { id: true, isActive: true } });
  const upcoming = await db.match.count({ where: { activity: { orgId: org.id }, status: { in: ["UPCOMING","TEAMS_GENERATED","TEAMS_PUBLISHED"] } } });
  const fresh = await db.organisation.findFirst({ where: { id: org.id }, select: { whatsappBotEnabled: true } });
  console.log("\nAFTER:");
  console.log("  activities:", JSON.stringify(acts));
  console.log(`  upcoming matches: ${upcoming}  (0 => nothing to post about)`);
  console.log(`  whatsappBotEnabled: ${fresh.whatsappBotEnabled}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
