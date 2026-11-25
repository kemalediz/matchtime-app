import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { inviteRecentPlayers } from "../src/lib/recruit.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const r = await inviteRecentPlayers(org.id);
  console.log(`ok=${r.ok} reason=${r.reason ?? "-"}`);
  console.log(`need=${r.need}  newly invited=${r.invited}  skipped (already invited)=${r.alreadyInvited ?? 0}`);
  console.log(`names: ${(r.invitedNames ?? []).join(", ") || "(none)"}`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
