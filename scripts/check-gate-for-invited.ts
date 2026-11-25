import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { canSelfMarkIn } from "../src/lib/group-membership-gate.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const NAMES = ["Abid Kazmi","Idris Yildiz","Adam Khandaza","Kieran","Burak Yildiz","Mauricio","Karahan Öztürk","Yoobie","Aydın"];
  console.log("=== can each DM'd player actually mark themselves IN via the app link? ===");
  let blocked = 0;
  for (const n of NAMES) {
    const u = await db.user.findFirst({ where: { name: n }, select: { id: true } });
    if (!u) { console.log(`  ${n.padEnd(16)} user missing`); continue; }
    const mem = await db.membership.findUnique({ where: { userId_orgId: { userId: u.id, orgId: org.id } }, select: { leftAt: true, lastSeenInGroupAt: true, role: true } });
    const ok = canSelfMarkIn(mem as any);
    if (!ok) blocked++;
    console.log(`  ${n.padEnd(16)} lastSeen=${mem?.lastSeenInGroupAt ? mem.lastSeenInGroupAt.toISOString().slice(0,10) : "NULL"} -> ${ok ? "CAN mark IN" : "BLOCKED !!"}`);
  }
  console.log(`\nBlocked: ${blocked}/${NAMES.length}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
