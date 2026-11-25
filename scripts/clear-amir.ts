import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const u = await db.user.findFirst({ where: { name: "Amir" }, select: { id:true, name:true } });
  const before = await db.attendance.findUnique({ where: { matchId_userId: { matchId: m.id, userId: u.id } }, select: { status:true, position:true } });
  console.log(`before: ${u.name} -> ${before ? before.status+" pos="+before.position : "no row"}`);
  // He never said anything about himself, so no row is the honest state.
  const del = await db.attendance.deleteMany({ where: { matchId: m.id, userId: u.id } });
  console.log(`deleted ${del.count} row(s)`);
  const conf = await db.attendance.count({ where: { matchId: m.id, status: "CONFIRMED" } });
  const bench = await db.attendance.count({ where: { matchId: m.id, status: "BENCH" } });
  console.log(`squad now ${conf}/${m.maxPlayers}, bench ${bench}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
