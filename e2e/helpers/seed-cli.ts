/**
 * tsx entry point that (re)seeds the ISOLATED e2e database. Invoked by
 * e2e/run.ts at startup and by specs (via fixtures.resetDb()) whenever
 * they need a pristine fixture world. Prisma lives ONLY in this tsx
 * world — see the note in seed.ts.
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { seedAll } from "./seed";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await seedAll(db);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[e2e seed] failed:", err);
  process.exit(1);
});
