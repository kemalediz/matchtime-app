import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { registerAttendance } from "../src/lib/attendance.ts";
const APPLY = process.argv.includes("--apply");
// Order = order they said "In" in the group this morning.
const INS = ["Mustafa Cayir"];
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const match = await db.match.findFirst({
    where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" },
    include: { activity: { select: { name: true } } },
  });
  console.log(`Match: ${match.activity.name} ${match.date.toISOString()} max=${match.maxPlayers}`);
  for (const n of INS) {
    const u = await db.user.findFirst({ where: { name: n, memberships: { some: { orgId: org.id, leftAt: null } } }, select: { id: true, name: true } });
    if (!u) { console.log(`  !! ${n}: NOT FOUND`); continue; }
    if (!APPLY) { console.log(`  would register ${u.name}`); continue; }
    const r = await registerAttendance(u.id, match.id);
    console.log(`  ${u.name} -> ${r.status} pos=${r.position}`);
  }
  if (APPLY) {
    const c = await db.attendance.count({ where: { matchId: match.id, status: "CONFIRMED" } });
    console.log(`\nSquad now ${c}/${match.maxPlayers}`);
  } else console.log("\n(dry-run)");
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
