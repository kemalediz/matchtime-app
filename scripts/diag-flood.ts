import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  console.log(`SentNotification rows in last 6h: ${sn.length}`);
  const byKind: Record<string, number> = {};
  for (const s of sn) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  console.log("by kind:", JSON.stringify(byKind));
  for (const s of sn.slice(-40)) {
    console.log(`  ${s.createdAt.toISOString()}  kind=${s.kind}  key=${s.key.slice(0, 70)}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
