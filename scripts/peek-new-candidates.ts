import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const next = await db.match.findFirst({ where: { activity: { orgId: org.id }, status: "UPCOMING" }, orderBy: { date: "asc" } });
  const pool = async (N:number) => {
    const ms = await db.match.findMany({ where: { activity: { orgId: org.id }, isHistorical:false, status:"COMPLETED" }, orderBy:{date:"desc"}, take:N,
      select: { attendances: { where:{status:"CONFIRMED"}, select:{ userId:true, user:{select:{name:true,phoneNumber:true}} } } } });
    const m = new Map<string,string>();
    for (const x of ms) for (const a of x.attendances) if (a.user.phoneNumber) m.set(a.userId, a.user.name ?? "?");
    return m;
  };
  const p3 = await pool(3), p5 = await pool(5);
  const responded = new Set((await db.attendance.findMany({ where:{matchId: next.id}, select:{userId:true}})).map((a:any)=>a.userId));
  const invited = new Set((await db.sentNotification.findMany({ where:{ key:{ startsWith: `${next.id}:recruit-dm:` } }, select:{key:true}})).map((s:any)=>s.key.split(":").pop()));
  console.log(`already invited: ${invited.size}   already responded: ${responded.size}`);
  console.log("\n=== NEW candidates unlocked by lookback 5 (not invited, not responded) ===");
  let n=0;
  for (const [id,name] of p5) if (!p3.has(id) && !responded.has(id) && !invited.has(id)) { console.log(`  ${name}`); n++; }
  console.log(`total new: ${n}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
