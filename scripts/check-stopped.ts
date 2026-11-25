import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" }, select: { name: true, whatsappBotEnabled: true } });
  console.log(`KILL SWITCH: ${org.name} whatsappBotEnabled=${org.whatsappBotEnabled}  (false = no due-posts served)`);
  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: new Date(Date.now()-3*3600*1000) } }, orderBy: { createdAt: "desc" }, take: 10 });
  console.log(`SentNotification last 3h: ${sn.length}`);
  for (const s of sn) console.log(`  ${s.createdAt.toISOString()} ${s.kind} ${s.key.slice(0,70)}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
