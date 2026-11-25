import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const since = new Date(Date.now()-24*3600*1000);
  const sn = await db.sentNotification.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  console.log("=== things MT actually SENT in 24h (text replies/posts) ===");
  for (const s of sn) console.log(`  ${s.createdAt.toLocaleString("en-GB",{timeZone:"Europe/London",hour:"2-digit",minute:"2-digit"})}  ${s.kind}  ${s.key.slice(0,48)}`);
  const am = await db.analyzedMessage.findMany({ where: { createdAt: { gte: since }, action: { not: null } }, select: { action: true, intent: true } });
  const byAction: Record<string,number> = {};
  for (const r of am) byAction[`${r.intent}/${r.action}`] = (byAction[`${r.intent}/${r.action}`] ?? 0)+1;
  console.log("\n=== verdict actions recorded (intent/action) ===");
  console.log(" ", JSON.stringify(byAction));
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
