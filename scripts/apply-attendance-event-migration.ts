/**
 * Apply prisma/migrations/20260901120000_attendance_event_log.
 *
 *   npx tsx scripts/apply-attendance-event-migration.ts            # DRY RUN
 *   npx tsx scripts/apply-attendance-event-migration.ts --apply    # do it
 *
 * Same shape as scripts/apply-block-booking-migration.ts: this repo has
 * no full Prisma migration history (see prisma.config.ts), so the
 * migration SQL is the reviewable artefact and this is how it is put on
 * a live database. Every statement is guarded (`IF NOT EXISTS`,
 * `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`), so a re-run is a
 * no-op.
 *
 * WHAT IT DOES — all additive:
 *   · CREATE TABLE "AttendanceEvent" (new, empty, no foreign keys)
 *   · five indexes on it
 *   · ALTER TABLE "AnalyzedMessage" ADD COLUMN "batchId" TEXT
 *     (nullable, no default → catalog-only, no table rewrite)
 *   · one index on that column
 *   · two triggers making "AttendanceEvent" append-only
 *
 * WHAT IT DOES NOT DO: rewrite a row, backfill anything, drop or rename
 * anything, or add a constraint to an existing table. The dry run prints
 * the row counts of both existing tables before and after so "nothing
 * was touched" is a number, not a promise.
 *
 * The e2e COVERAGE gate (prisma/sql/attendance-event-coverage.sql) is
 * deliberately NOT applied here — arming it in production would turn a
 * writer we missed into a thrown registration. See that file.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as any);

  const state = async () => {
    const table: any = await db.$queryRawUnsafe(
      `SELECT to_regclass('"AttendanceEvent"')::text AS t;`,
    );
    const col: any = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name='AnalyzedMessage' AND column_name='batchId';`,
    );
    const trg: any = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM pg_trigger
        WHERE tgname IN ('attendance_event_no_update','attendance_event_no_delete');`,
    );
    const msgs: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AnalyzedMessage";`);
    const atts: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "Attendance";`);
    return {
      table: table[0].t ?? "MISSING",
      col: col[0].n ? "present" : "MISSING",
      triggers: trg[0].n,
      analyzedMessages: msgs[0].n,
      attendances: atts[0].n,
    };
  };

  const before = await state();
  console.log(
    `BEFORE: AttendanceEvent=${before.table}  AnalyzedMessage.batchId=${before.col}  ` +
      `append-only triggers=${before.triggers}/2  ` +
      `(AnalyzedMessage rows: ${before.analyzedMessages}, Attendance rows: ${before.attendances})`,
  );
  if (!APPLY) {
    console.log("(dry run — pass --apply to make the change)");
    await db.$disconnect();
    return;
  }

  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AttendanceEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fromStatus" "AttendanceStatus",
    "toStatus" "AttendanceStatus",
    "fromPosition" INTEGER,
    "toPosition" INTEGER,
    "cause" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "sourceRef" TEXT,
    "note" TEXT,
    "txId" TEXT DEFAULT txid_current()::text,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id"));`);

  for (const [name, cols] of [
    ["AttendanceEvent_matchId_at_idx", `"matchId", "at"`],
    ["AttendanceEvent_matchId_userId_at_idx", `"matchId", "userId", "at"`],
    ["AttendanceEvent_orgId_at_idx", `"orgId", "at"`],
    ["AttendanceEvent_userId_at_idx", `"userId", "at"`],
    ["AttendanceEvent_txId_idx", `"txId"`],
  ] as const) {
    await db.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "${name}" ON "AttendanceEvent"(${cols});`,
    );
  }

  await db.$executeRawUnsafe(`ALTER TABLE "AnalyzedMessage" ADD COLUMN IF NOT EXISTS "batchId" TEXT;`);
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "AnalyzedMessage_batchId_idx" ON "AnalyzedMessage"("batchId");`,
  );

  // Append-only. The whole value of the table is that it cannot be
  // rewritten, so this is enforced in the database, not by convention.
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION attendance_event_no_mutate()
    RETURNS TRIGGER AS $fn$
    BEGIN
      RAISE EXCEPTION '"AttendanceEvent" is append-only: % is not permitted. Record a new event instead.', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $fn$ LANGUAGE plpgsql;`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS attendance_event_no_update ON "AttendanceEvent";`);
  await db.$executeRawUnsafe(`CREATE TRIGGER attendance_event_no_update
    BEFORE UPDATE ON "AttendanceEvent" FOR EACH ROW EXECUTE FUNCTION attendance_event_no_mutate();`);
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS attendance_event_no_delete ON "AttendanceEvent";`);
  await db.$executeRawUnsafe(`CREATE TRIGGER attendance_event_no_delete
    BEFORE DELETE ON "AttendanceEvent" FOR EACH ROW EXECUTE FUNCTION attendance_event_no_mutate();`);

  const after = await state();
  console.log(
    `AFTER:  AttendanceEvent=${after.table}  AnalyzedMessage.batchId=${after.col}  ` +
      `append-only triggers=${after.triggers}/2  ` +
      `(AnalyzedMessage rows: ${after.analyzedMessages}, Attendance rows: ${after.attendances})`,
  );
  if (
    after.analyzedMessages !== before.analyzedMessages ||
    after.attendances !== before.attendances
  ) {
    throw new Error("row counts changed — this migration must be additive only");
  }
  console.log("existing rows untouched ✓  (purely additive, as intended)");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
