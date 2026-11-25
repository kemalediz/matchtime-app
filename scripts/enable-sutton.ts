import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const APPLY = process.argv.includes("--apply");
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const intro = await db.sentNotification.findMany({ where: { key: { startsWith: `org-${org.id}:` } }, select: { key: true } });
  console.log(`org-level one-time keys already sent: ${intro.length ? intro.map((i:any)=>i.key).join(", ") : "NONE  <-- intro would re-post!"}`);
  if (!APPLY) { console.log("(dry-run)"); await db.$disconnect(); return; }
  await db.activity.update({ where: { id: "tuesday-7aside" }, data: { isActive: true } });
  await db.organisation.update({ where: { id: org.id }, data: { whatsappBotEnabled: true } });
  const fresh = await db.organisation.findFirst({ where: { id: org.id }, select: { whatsappBotEnabled: true } });
  const acts = await db.activity.findMany({ where: { orgId: org.id }, select: { id: true, isActive: true } });
  const next = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  console.log(`\nENABLED: botEnabled=${fresh.whatsappBotEnabled}`);
  console.log(`activities: ${JSON.stringify(acts)}`);
  console.log(`next match: ${next.date.toISOString()} (${next.date.toLocaleString("en-GB",{timeZone:"Europe/London"})})`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
