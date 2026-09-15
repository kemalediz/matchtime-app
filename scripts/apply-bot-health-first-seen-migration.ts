/**
 * Apply prisma/migrations/20260915120000_bot_health_first_seen.
 *
 *   npx tsx scripts/apply-bot-health-first-seen-migration.ts            # DRY RUN
 *   npx tsx scripts/apply-bot-health-first-seen-migration.ts --apply    # do it
 *
 * Same shape as scripts/apply-attendance-event-migration.ts: this repo
 * has no full Prisma migration history (see prisma.config.ts), so the
 * migration SQL is the reviewable artefact and this is how it is put on
 * a live database. The one statement is guarded with IF NOT EXISTS, so
 * a re-run is a no-op.
 *
 * WHAT IT DOES:
 *   · ALTER TABLE "BotHealth" ADD COLUMN "codeFirstSeenAt" JSONB
 *     (nullable, no default, so catalog-only: no table rewrite)
 *
 * WHAT IT DOES NOT DO: rewrite a row, backfill anything, drop or rename
 * anything, add an index, or add a constraint. Deliberately no backfill:
 * `trackFirstSeen` stamps a code that predates the ledger with
 * `BotHealth.createdAt`, which is the earliest instant this monitor
 * could have known about it, and that rule belongs in the code that
 * owns it rather than in a one-off UPDATE. See the migration SQL.
 *
 * The dry run prints the row count and the existing alert state so
 * "nothing was touched" is a number rather than a promise.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const state = async () => {
    const col: any = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name='BotHealth' AND column_name='codeFirstSeenAt';`,
    );
    const rows: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "BotHealth";`);
    return { col: col[0].n ? "present" : "MISSING", rows: rows[0].n };
  };

  const before = await state();
  console.log(`BEFORE: BotHealth."codeFirstSeenAt"=${before.col}  (BotHealth rows: ${before.rows})`);

  const alerts: any = await db.$queryRawUnsafe(
    `SELECT o.name, h."lastAlertAt", h."lastAlertCodes", h."createdAt"
       FROM "BotHealth" h JOIN "Organisation" o ON o.id = h."orgId";`,
  );
  for (const a of alerts) {
    console.log(
      `        ${a.name}: codes=[${(a.lastAlertCodes ?? []).join(", ")}] ` +
        `lastAlertAt=${a.lastAlertAt?.toISOString() ?? "never"} ` +
        `rowCreatedAt=${a.createdAt?.toISOString() ?? "?"} ` +
        `(the back-stamp each of those codes will get)`,
    );
  }

  if (!APPLY) {
    console.log("(dry run, pass --apply to make the change)");
    await db.$disconnect();
    return;
  }

  await db.$executeRawUnsafe(
    `ALTER TABLE "BotHealth" ADD COLUMN IF NOT EXISTS "codeFirstSeenAt" JSONB;`,
  );

  const after = await state();
  console.log(`AFTER:  BotHealth."codeFirstSeenAt"=${after.col}  (BotHealth rows: ${after.rows})`);
  if (after.rows !== before.rows) {
    console.error("ROW COUNT CHANGED. This migration must not touch a row. Investigate.");
    process.exitCode = 1;
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
