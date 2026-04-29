/** List the 65 active Sutton members + their phones, so we can spot
 *  who's in the DB but might not be in the WA group anymore. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton" } },
    select: { id: true, name: true },
  });
  if (!org) return console.error("Sutton org not found");

  const ms = await db.membership.findMany({
    where: { orgId: org.id, leftAt: null },
    include: {
      user: { select: { id: true, name: true, phoneNumber: true, email: true, createdAt: true } },
    },
    orderBy: { user: { name: "asc" } },
  });
  console.log(`Active Sutton memberships: ${ms.length}`);
  for (const m of ms) {
    const recent =
      m.user.createdAt &&
      Date.now() - m.user.createdAt.getTime() < 1000 * 60 * 60 * 24
        ? "  ← created <24h ago (likely lurker-backfill)"
        : "";
    console.log(
      `  ${(m.user.name ?? "(unnamed)").padEnd(28)} ${m.user.phoneNumber ?? "(no phone)"}${recent}`,
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
