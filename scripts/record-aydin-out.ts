import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const APPLY = process.argv.includes("--apply");
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const u = await db.user.findFirst({ where: { name: { contains: "Ayd", mode: "insensitive" } }, select: { id:true, name:true } });
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const maxPos = await db.attendance.aggregate({ where: { matchId: m.id }, _max: { position: true } });
  const pos = (maxPos._max.position ?? 0) + 1;
  console.log(`Recording ${u.name} as DROPPED (said "No thank you" 12:11) at position ${pos}`);
  if (!APPLY) { console.log("(dry-run)"); await db.$disconnect(); return; }
  await db.attendance.upsert({
    where: { matchId_userId: { matchId: m.id, userId: u.id } },
    create: { matchId: m.id, userId: u.id, status: "DROPPED", position: pos },
    update: { status: "DROPPED" },
  });
  const conf = await db.attendance.count({ where: { matchId: m.id, status: "CONFIRMED" } });
  console.log(`done. squad still ${conf}/${m.maxPlayers}; Aydın now counts as RESPONDED so no chase will fire.`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
