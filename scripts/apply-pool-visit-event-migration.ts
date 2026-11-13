/**
 * Apply prisma/migrations/20261113120000_pool_visit_events (the /play visit
 * log, kept 90 days).
 *
 *   npx tsx scripts/apply-pool-visit-event-migration.ts            # DRY RUN
 *   npx tsx scripts/apply-pool-visit-event-migration.ts --apply    # do it
 *
 * Same shape as scripts/apply-attendance-event-migration.ts: this repo has
 * no full Prisma migration history (see prisma.config.ts), so the migration
 * SQL is the reviewable artefact and this is one way to put it on a live
 * database (`psql -f` on the file is the other). It runs THAT FILE's
 * statements, not a copy, in one transaction with the file's own
 * `SET LOCAL lock_timeout`. Every statement is guarded (`IF NOT EXISTS`,
 * constraints dropped and re-added), so a re-run is a no-op.
 *
 * WHAT IT DOES, all additive: CREATE TABLE "PoolVisitEvent" (new, empty, no
 * foreign key), its 7 CHECKs and two indexes ("at" for the deletion, "code",
 * "at" for the volume cap). It rewrites, backfills,
 * drops or renames nothing. The dry run prints the table's state and the
 * funnel counters' row count; the apply checks that count is unchanged.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");
const FILE = path.join(__dirname, "..", "prisma", "migrations", "20261113120000_pool_visit_events", "migration.sql");

/** The file's statements, without its comments and its own BEGIN, SET LOCAL
 *  and COMMIT (the transaction below stands in for them). */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ""))
    .filter((s) => s && !/^(BEGIN|COMMIT|SET LOCAL\b)/i.test(s));
}

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const state = async () => {
    const table: any = await db.$queryRawUnsafe(`SELECT to_regclass('"PoolVisitEvent"')::text AS t;`);
    const checks: any = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname LIKE 'PoolVisitEvent\\_%\\_check';`,
    );
    const counters: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "PoolCampaignVisit";`);
    return { table: table[0].t ?? "MISSING", checks: checks[0].n, counterRows: counters[0].n };
  };

  const todo = statements(readFileSync(FILE, "utf8"));
  const before = await state();
  console.log(`BEFORE: PoolVisitEvent=${before.table}  CHECKs=${before.checks}/7  (PoolCampaignVisit rows: ${before.counterRows})`);
  if (!APPLY) {
    console.log(`(dry run: ${todo.length} statements would run; pass --apply to make the change)`);
    for (const s of todo) console.log(`  ${s.split("\n")[0]}`);
    await db.$disconnect();
    return;
  }

  await db.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    for (const s of todo) await tx.$executeRawUnsafe(s);
  });

  const after = await state();
  console.log(`AFTER:  PoolVisitEvent=${after.table}  CHECKs=${after.checks}/7  (PoolCampaignVisit rows: ${after.counterRows})`);
  if (after.counterRows !== before.counterRows) throw new Error("PoolCampaignVisit row count changed: this migration must be additive only");
  if (after.table === "MISSING" || after.checks !== 7) throw new Error("PoolVisitEvent is not complete");
  console.log("existing rows untouched, table and CHECKs in place");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
