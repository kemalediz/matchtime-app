import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const u = await db.user.findFirst({ where: { name: { contains: "Ayd", mode: "insensitive" } }, select: { id:true, name:true, phoneNumber:true } });
  console.log(`user: ${JSON.stringify(u)}`);
  const m = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const att = await db.attendance.findUnique({ where: { matchId_userId: { matchId: m.id, userId: u.id } } });
  console.log(`attendance for tomorrow: ${att ? att.status : "NONE  <-- counts as 'no response' => WILL BE CHASED"}`);
  const inv = await db.sentNotification.findUnique({ where: { key: `${m.id}:recruit-dm:${u.id}` }, select: { createdAt:true } });
  console.log(`invited at: ${inv ? inv.createdAt.toISOString() : "n/a"}`);
  if (inv) console.log(`chase due at: ${new Date(inv.createdAt.getTime()+3*3600*1000).toLocaleString("en-GB",{timeZone:"Europe/London"})}`);
  const chased = await db.sentNotification.findUnique({ where: { key: `${m.id}:recruit-chase:${u.id}` } });
  console.log(`already chased: ${chased ? "yes" : "no"}`);
  console.log(`now: ${new Date().toLocaleString("en-GB",{timeZone:"Europe/London"})}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
