import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);

  const orgs = await db.organisation.findMany();
  const users = await db.user.findMany({
    select: { id: true, email: true, name: true, phoneNumber: true, positions: true },
    orderBy: { name: "asc" },
  });
  // The seed is per club since 2026-09-19, so it comes back on the
  // membership. `User.seedRating` was dropped in slice 7.
  const memberships = await db.membership.findMany({
    select: { userId: true, orgId: true, role: true, seedRating: true, matchRating: true },
  });
  const activities = await db.activity.findMany();
  const matchCount = await db.match.count();

  console.log(JSON.stringify({ orgs, userCount: users.length, users, memberships, activities, matchCount }, null, 2));

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
