import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const now = new Date();
  const ms = await db.match.findMany({
    where: { activity: { orgId: org.id }, attendances: { some: { status: "CONFIRMED", paidAt: null } } },
    select: { id: true, date: true, status: true, paymentLinksReleasedAt: true, feePerPlayer: true },
    orderBy: { date: "desc" }, take: 12,
  });
  console.log("=== matches carrying unpaid confirmed attendances ===");
  for (const m of ms) {
    const days = m.paymentLinksReleasedAt ? ((now.getTime() - m.paymentLinksReleasedAt.getTime())/(864e5)) : null;
    const wouldChase = m.paymentLinksReleasedAt != null && m.feePerPlayer != null && days !== null && days <= 10;
    console.log(`  ${m.date.toISOString().slice(0,10)} [${m.status}] linksReleased=${days ? days.toFixed(1)+"d ago" : "never"} fee=${m.feePerPlayer ?? "null"}  WOULD_CHASE=${wouldChase ? "YES !!" : "no"}`);
  }
  console.log(`\npaymentCollectionEnabled=${org.paymentCollectionEnabled}`);
  const recentCompleted = await db.match.count({
    where: { activity: { orgId: org.id }, status: "COMPLETED", date: { gte: new Date(now.getTime() - 14*864e5) } },
  });
  console.log(`COMPLETED matches in last 14 days (scheduler window): ${recentCompleted}`);
  const blocks = await db.blockBooking.count({ where: { orgId: org.id } });
  console.log(`Existing block bookings: ${blocks}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
