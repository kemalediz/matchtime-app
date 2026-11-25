import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" }, include: { activity: true } });
  const conf = await db.attendance.findMany({ where: { matchId: m.id, status: "CONFIRMED" }, include: { user: { select: { name: true } } }, orderBy: { position: "asc" } });
  const need = m.maxPlayers - conf.length;
  const text =
    `🗓 *${m.activity.name}* — Tue 1 Sept, 21:30 at ${m.activity.venue}.\n\n` +
    `*Confirmed (${conf.length}/${m.maxPlayers}):*\n` +
    conf.map((a:any,i:number)=>`${i+1}. ${a.user.name}`).join("\n") +
    `\n\nWe need *${need} more*. Reply *IN* to grab a spot.`;
  const job = await db.botJob.create({ data: { orgId: org.id, kind: "group", text } });
  console.log(`Queued BotJob ${job.id} at ${new Date().toISOString()}`);
  console.log(`--- text ---\n${text}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
