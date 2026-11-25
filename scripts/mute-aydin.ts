import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const u = await db.user.findFirst({ where: { phoneNumber: "+447887275188" }, select: { id:true, name:true } });
  const r = await db.membership.updateMany({
    where: { userId: u.id, leftAt: null },
    data: { subMatchInviteDm: false, subBenchOfferDm: false, subTentativeDm: false, subPrefsUpdatedAt: new Date() },
  });
  console.log(`Muted match invites/bench/tentative for ${u.name} on ${r.count} membership(s).`);
  const m = await db.membership.findFirst({ where: { userId: u.id, leftAt: null }, select: { subMatchInviteDm:true, subBenchOfferDm:true, subTentativeDm:true, subRatingDm:true, subReminderDm:true } });
  console.log(`now: ${JSON.stringify(m)}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
