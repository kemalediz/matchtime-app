import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const att = await db.attendance.findMany({ where: { matchId: m.id }, include: { user: { select: { name: true } } }, orderBy: { position: "asc" } });
  const conf = att.filter((a:any)=>a.status==="CONFIRMED").length;
  console.log(`Squad ${conf}/${m.maxPlayers}  (open slots: ${m.maxPlayers-conf})`);
  for (const a of att) console.log(`  #${a.position} ${(a.user.name??"?").padEnd(16)} ${a.status}${a.status==="BENCH" && conf<m.maxPlayers ? "   <-- ON BENCH WHILE SLOTS ARE OPEN" : ""}`);
  console.log("\n=== last non-null waMessageId (audit says 18 July) ===");
  const wa = await db.sentNotification.findFirst({ where: { waMessageId: { not: null } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  console.log(`  ${wa ? wa.createdAt.toISOString() : "none ever"}`);
  console.log("\n=== members blocked from app self-IN (lastSeenInGroupAt null) ===");
  const blocked = await db.membership.count({ where: { orgId: org.id, leftAt: null, lastSeenInGroupAt: null } });
  const total = await db.membership.count({ where: { orgId: org.id, leftAt: null } });
  console.log(`  ${blocked} of ${total} active members`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
