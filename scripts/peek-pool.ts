import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  for (const N of [3,5,10,20]) {
    const recent = await db.match.findMany({
      where: { activity: { orgId: org.id }, isHistorical: false, status: "COMPLETED" },
      orderBy: { date: "desc" }, take: N,
      select: { date: true, attendances: { where: { status: "CONFIRMED" }, select: { userId: true, user: { select: { name: true, phoneNumber: true } } } } },
    });
    const pool = new Map<string,string>();
    let noPhone = 0;
    for (const m of recent) for (const a of m.attendances) {
      if (!a.user.phoneNumber) { noPhone++; continue; }
      pool.set(a.userId, a.user.name ?? "?");
    }
    console.log(`lookback ${String(N).padStart(2)} matches -> ${recent.length} found, pool of ${pool.size} distinct players (skipped ${noPhone} with no phone)`);
  }
  const total = await db.match.count({ where: { activity: { orgId: org.id }, status: "COMPLETED", isHistorical: false } });
  const members = await db.membership.count({ where: { orgId: org.id, leftAt: null } });
  console.log(`\ncompleted matches on record: ${total}   active members in org: ${members}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
