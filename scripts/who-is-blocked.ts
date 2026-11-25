import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
async function main(){
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);
  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });
  const blocked = await db.membership.findMany({
    where: { orgId: org.id, leftAt: null, lastSeenInGroupAt: null, role: "PLAYER" },
    include: { user: { select: { name: true, phoneNumber: true } } },
  });
  console.log(`Blocked from app self-IN: ${blocked.length}`);
  for (const m of blocked) console.log(`  ${(m.user.name ?? "?").padEnd(18)} phone=${m.user.phoneNumber ?? "none"}  joined=${m.createdAt.toISOString().slice(0,10)}`);
  const lastSync = await db.membership.aggregate({ where: { orgId: org.id }, _max: { lastSeenInGroupAt: true } });
  console.log(`\nMost recent successful participant sync: ${lastSync._max.lastSeenInGroupAt?.toISOString().slice(0,10) ?? "never"}`);
  console.log(`Today: ${new Date().toISOString().slice(0,10)}  -> sync has been dead ~8 weeks`);
  await db.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
