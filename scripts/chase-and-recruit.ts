import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { inviteRecentPlayers } from "../src/lib/recruit.ts";
const APPLY = process.argv.includes("--apply");
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" }, include: { activity: true } });
  const conf = await db.attendance.findMany({ where: { matchId: m.id, status: "CONFIRMED" }, include: { user: { select: { name: true } } }, orderBy: { position: "asc" } });
  const need = m.maxPlayers - conf.length;
  const text =
    `⚽ *${m.activity.name}* — tomorrow, Tue 1 Sept, 21:30 at ${m.activity.venue}.\n\n` +
    `*Confirmed (${conf.length}/${m.maxPlayers}):*\n` +
    conf.map((a:any,i:number)=>`${i+1}. ${a.user.name}`).join("\n") +
    `\n\nWe still need *${need} more* to play. Reply *IN* and I'll add you 👍`;
  console.log("--- group post ---\n" + text + "\n");
  if (!APPLY) { console.log("(dry-run)"); await db.$disconnect(); return; }
  const job = await db.botJob.create({ data: { orgId: org.id, kind: "group", text } });
  console.log(`queued group post ${job.id}`);
  const r = await inviteRecentPlayers(org.id);
  console.log(`\n--- recruit DMs ---\nok=${r.ok} reason=${r.reason ?? "-"} need=${r.need} invited=${r.invited} alreadyInvited=${r.alreadyInvited ?? 0}`);
  console.log(`names: ${(r.invitedNames ?? []).join(", ") || "(none)"}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
