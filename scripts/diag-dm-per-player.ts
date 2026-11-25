import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const since = new Date(Date.now() - 7*24*3600*1000);
  const sn = await db.sentNotification.findMany({
    where: { createdAt: { gte: since }, targetUser: { not: null } },
  });
  const ids = [...new Set(sn.map((s:any)=>s.targetUser))];
  const users = await db.user.findMany({ where: { id: { in: ids as string[] } }, select: { id: true, name: true } });
  const nameById = new Map(users.map((u:any)=>[u.id,u.name]));

  const per: Record<string, { total: number; kinds: Record<string, number> }> = {};
  for (const s of sn) {
    const n = (nameById.get(s.targetUser!) ?? s.targetUser!) as string;
    (per[n] ??= { total: 0, kinds: {} });
    per[n].total++;
    per[n].kinds[s.kind] = (per[n].kinds[s.kind] ?? 0) + 1;
  }
  console.log("=== DMs per player, last 7 days (worst first) ===");
  for (const [n, v] of Object.entries(per).sort((a,b)=>b[1].total-a[1].total)) {
    console.log(`${String(v.total).padStart(3)}  ${n}   ${JSON.stringify(v.kinds)}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
