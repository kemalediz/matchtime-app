import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const start = new Date(); start.setHours(0,0,0,0);

  const am = await db.analyzedMessage.findMany({ where: { createdAt: { gte: start } }, orderBy: { createdAt: "asc" } });
  console.log(`=== AnalyzedMessage today: ${am.length} ===`);
  for (const r of am) {
    const t = r.createdAt.toLocaleString("en-GB", { timeZone: "Europe/London", hour:"2-digit", minute:"2-digit" });
    console.log(`  [${t}] by=${r.handledBy} intent=${r.intent} author=${r.authorName ?? "?"} "${(r.body ?? "").slice(0,40).replace(/\n/g," ")}"`);
  }

  const next = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const att = await db.attendance.findMany({ where: { matchId: next.id }, include: { user: { select: { name: true } } }, orderBy: { position: "asc" } });
  console.log(`\n=== Attendance for ${next.date.toISOString()} : ${att.length} ===`);
  for (const a of att) console.log(`  #${a.position} ${a.user.name} ${a.status}`);

  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: start } }, orderBy: { createdAt: "asc" } });
  console.log(`\n=== SentNotification today: ${sn.length} ===`);
  for (const s of sn) console.log(`  ${s.createdAt.toLocaleString("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"})} ${s.kind} ${s.key.slice(0,55)} wa=${s.waMessageId ? "yes":"NULL"}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
