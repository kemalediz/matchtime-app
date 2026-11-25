import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const NAMES = ["Abid Kazmi","Idris Yildiz","Adam Khandaza","Kieran","Burak Yildiz","Mauricio","Karahan Öztürk","Yoobie","Aydın"];
  console.log("=== did any DM'd player already have a response for tomorrow? ===");
  for (const n of NAMES) {
    const u = await db.user.findFirst({ where: { name: n }, select: { id: true, name: true } });
    if (!u) { console.log(`  ${n.padEnd(16)} -> user not found`); continue; }
    const a = await db.attendance.findUnique({ where: { matchId_userId: { matchId: m.id, userId: u.id } }, select: { status: true } });
    console.log(`  ${n.padEnd(16)} -> ${a ? "HAS RESPONSE: "+a.status+"  <-- should NOT have been DM'd" : "no response (correct target)"}`);
  }
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
