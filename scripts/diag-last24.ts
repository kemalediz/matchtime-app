import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const since = new Date(Date.now()-20*3600*1000);
  const am = await db.analyzedMessage.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  console.log(`=== AnalyzedMessage last 20h: ${am.length} ===`);
  for (const r of am) {
    const t = r.createdAt.toLocaleString("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"});
    console.log(`  [${t}] by=${r.handledBy} intent=${r.intent} action=${r.action ?? "-"} author=${r.authorName ?? "NULL"} user=${r.authorUserId ? "OK" : "UNATTRIBUTED"}`);
    console.log(`        "${(r.body ?? "").slice(0,55).replace(/\n/g," ")}"`);
  }
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const att = await db.attendance.findMany({ where: { matchId: m.id }, include: { user: { select: { name: true } } }, orderBy: { position: "asc" } });
  console.log(`\n=== Squad (${att.filter((a:any)=>a.status==="CONFIRMED").length}/${m.maxPlayers}) ===`);
  for (const a of att) console.log(`  #${a.position} ${a.user.name} ${a.status}`);
  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  console.log(`\n=== MT sent last 20h: ${sn.length} ===`);
  for (const s of sn) console.log(`  ${s.createdAt.toLocaleString("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"})} ${s.kind} ${s.key.slice(0,50)} wa=${s.waMessageId?"set":"NULL"}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
