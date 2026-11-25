import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const now = new Date();
  const dayKey = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const key = `${m.id}:evening-update:${dayKey}`;
  const already = await db.sentNotification.findUnique({ where: { key } });
  console.log(`evening-update key for today: ${key}`);
  console.log(`  already sent today? ${already ? "YES at "+already.createdAt.toISOString() : "no — will fire at 17:00"}`);
  console.log(`  beforeDeadline: ${now < m.attendanceDeadline}`);
  console.log(`  status: ${m.status}  (isPrematch needs UPCOMING/TEAMS_*)`);
  const conf = await db.attendance.count({ where: { matchId: m.id, status: "CONFIRMED" } });
  console.log(`  squad: ${conf}/${m.maxPlayers} -> message would say "need ${m.maxPlayers-conf} more"`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
