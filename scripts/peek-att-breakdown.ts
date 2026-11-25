import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const org = await db.organisation.findFirst({ where: { slug: "sutton-fc" } });

  const rashads = await db.user.findMany({
    where: { name: { contains: "ashad", mode: "insensitive" } },
    include: {
      memberships: { where: { orgId: org!.id } },
      attendances: {
        include: { match: { select: { date: true, status: true } } },
        orderBy: { match: { date: "desc" } },
        take: 5,
      },
    },
  });

  for (const u of rashads) {
    const m = u.memberships[0];
    console.log(`USER ${u.name}  id=${u.id}`);
    console.log(`  phoneNumber=${u.phoneNumber ?? "NULL"}  onboarded=${u.onboarded}  email=${u.email}`);
    console.log(
      `  membership: role=${m?.role}  provisionallyAddedAt=${m?.provisionallyAddedAt?.toISOString() ?? "null"}`,
    );
    console.log(
      `  lastSeenInGroupAt=${m?.lastSeenInGroupAt?.toISOString() ?? "NULL (never seen in WA group sync)"}  leftAt=${m?.leftAt?.toISOString() ?? "null"}`,
    );
    console.log(`  attendances:`);
    for (const a of u.attendances) {
      console.log(`    ${a.match.date.toISOString()} [${a.match.status}] status=${a.status} pos=${a.position}`);
    }
    console.log();
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
