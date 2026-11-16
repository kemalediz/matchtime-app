/**
 * Apply prisma/migrations/20261116120000_deleted_messages (the tombstone of
 * a WhatsApp message deleted for everyone or edited by its author, kept 14
 * days, and the GroupMessage ("waChatId", "createdAt") index).
 *
 *   npx tsx scripts/apply-deleted-message-migration.ts            # DRY RUN
 *   npx tsx scripts/apply-deleted-message-migration.ts --apply    # do it
 *
 * Same shape as scripts/apply-pool-visit-event-migration.ts: this repo has
 * no full Prisma migration history (see prisma.config.ts), so the migration
 * SQL is the reviewable artefact and this is one way to put it on a live
 * database (`psql -f` on the file is the other). It runs THAT FILE's
 * statements, not a copy, in one transaction with the file's own
 * `SET LOCAL lock_timeout`. Every statement is guarded (`IF NOT EXISTS`),
 * so a re-run is a no-op.
 *
 * WHAT IT DOES, all additive: CREATE TABLE "DeletedMessage" (new, empty, no
 * foreign key), one unique index ("chatId", "waMessageId"), one index
 * ("lastChangeAt", for the pruning), one ("enforcedAt", "lastChangeAt", for
 * the sweep), and CREATE INDEX on the existing
 * "GroupMessage" ("waChatId", "createdAt"), and two "FormNote" columns
 * ("reasonSourceMessageId", "reasonMessageIds"). It rewrites, backfills, drops
 * or renames nothing. The dry run prints the state; the apply checks every
 * object is in place.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");
const FILE = path.join(__dirname, "..", "prisma", "migrations", "20261116120000_deleted_messages", "migration.sql");

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
    const table: any = await db.$queryRawUnsafe(`SELECT to_regclass('"DeletedMessage"')::text AS t;`);
    const unique: any = await db.$queryRawUnsafe(`SELECT to_regclass('"DeletedMessage_chatId_waMessageId_key"')::text AS t;`);
    const archiveIdx: any = await db.$queryRawUnsafe(`SELECT to_regclass('"GroupMessage_waChatId_createdAt_idx"')::text AS t;`);
    // Every DeletedMessage index: the sweep's two and the unique key above.
    const sweepIdx: any = await db.$queryRawUnsafe(
      `SELECT (to_regclass('"DeletedMessage_lastChangeAt_idx"') IS NOT NULL AND to_regclass('"DeletedMessage_enforcedAt_lastChangeAt_idx"') IS NOT NULL) AS ok;`,
    );
    const enforced: any = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'DeletedMessage' AND column_name IN ('enforcedAt', 'lastChangeAt', 'changes');`,
    );
    const analyzed: any = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AnalyzedMessage";`);
    const noteCol: any = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'FormNote' AND column_name IN ('reasonSourceMessageId', 'reasonMessageIds');`,
    );
    return { table: table[0].t ?? "MISSING", unique: unique[0].t ?? "MISSING", archiveIdx: archiveIdx[0].t ?? "MISSING", enforcedAt: enforced[0].n === 3 && noteCol[0].n === 2 && sweepIdx[0].ok === true, analyzedRows: analyzed[0].n };
  };

  const todo = statements(readFileSync(FILE, "utf8"));
  const before = await state();
  console.log(`BEFORE: DeletedMessage=${before.table}  unique index=${before.unique}  GroupMessage index=${before.archiveIdx}  columns+sweep indexes=${before.enforcedAt}  (AnalyzedMessage rows: ${before.analyzedRows})`);
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
  console.log(`AFTER:  DeletedMessage=${after.table}  unique index=${after.unique}  GroupMessage index=${after.archiveIdx}  columns+sweep indexes=${after.enforcedAt}  (AnalyzedMessage rows: ${after.analyzedRows})`);
  if (after.table === "MISSING" || after.unique === "MISSING" || after.archiveIdx === "MISSING" || !after.enforcedAt) throw new Error("the migration is not complete");
  console.log("table and indexes in place; nothing else touched");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
