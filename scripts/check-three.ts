import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  for (const phone of ["+447479815140","+447385849848","+447887275188"]) {
    const u = await db.user.findFirst({ where: { phoneNumber: phone }, select: { id:true, name:true, phoneNumber:true } });
    if (!u) { console.log(`${phone}: NO USER`); continue; }
    const mems = await db.membership.findMany({ where: { userId: u.id }, include: { org: { select: { name:true, slug:true, whatsappBotEnabled:true } } } });
    console.log(`\n=== ${u.name} (${phone}) ===`);
    for (const m of mems) {
      console.log(`  org=${m.org.name} botEnabled=${m.org.whatsappBotEnabled} left=${m.leftAt ? "YES":"no"}`);
      console.log(`    subs: invite=${m.subMatchInviteDm} bench=${m.subBenchOfferDm} tentative=${m.subTentativeDm} rating=${m.subRatingDm} reminder=${m.subReminderDm}`);
    }
  }
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
