/**
 * Smoke-test loadRecentHistory against the live DB and print the
 * formatted block so we can eyeball what the LLM will see.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { loadRecentHistory, formatRecentHistoryBlock } from "../src/lib/match-history.ts";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter } as any);
  // Find Sutton.
  const org = await db.organisation.findFirst({
    where: { slug: { contains: "sutton", mode: "insensitive" } },
    select: { id: true, name: true, slug: true },
  });
  if (!org) {
    console.error("No Sutton org found");
    process.exit(1);
  }
  console.log(`Org: ${org.name} (${org.id})\n`);

  const t0 = Date.now();
  const history = await loadRecentHistory(org.id);
  const ms = Date.now() - t0;
  console.log(`loadRecentHistory took ${ms}ms\n`);

  if (!history) {
    console.log("(no completed matches yet)");
  } else {
    console.log(formatRecentHistoryBlock(history));
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
