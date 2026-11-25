import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const del = await db.botJob.deleteMany({ where: { id: "cmtefzy3y0000ba9kn4jimxt6", sentAt: null } });
  console.log(`removed pending GROUP probe: ${del.count} (0 = it already sent)`);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const job = await db.botJob.create({
    data: { orgId: org.id, kind: "dm", phone: "447525334985",
            text: "🔧 MatchTime test — if you got this, the bot is alive and sending. Squad for Tue 1 Sept is 7/14." },
  });
  console.log(`queued DM probe ${job.id} -> +447525334985 at ${new Date().toISOString()}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
