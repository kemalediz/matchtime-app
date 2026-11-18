/**
 * Apply prisma/migrations/20261116120000_mom_announcement (what a Man of the
 * Match announcement told the group, stored when it is claimed).
 *
 *   npx tsx scripts/apply-mom-announcement-migration.ts            # DRY RUN
 *   npx tsx scripts/apply-mom-announcement-migration.ts --apply    # do it
 *
 * Same shape as scripts/apply-pool-visit-event-migration.ts: this repo has
 * no full Prisma migration history (see prisma.config.ts), so the migration
 * SQL is the reviewable artefact and this is one way to put it on a live
 * database (`psql -f` on the file is the other). It runs THAT FILE's
 * statements, not a copy, in one transaction with the file's own
 * `SET LOCAL lock_timeout`. Every statement is guarded (`IF NOT EXISTS`, the
 * constraint dropped and re-added), so a re-run is a no-op.
 *
 * WHAT IT DOES, all additive: CREATE TABLE "MoMAnnouncement" (new, empty)
 * and its foreign key to "Match". It rewrites, backfills, drops or renames
 * nothing. The dry run prints the table's state and the number of MoM
 * announcement claims (counted once, by key, no full-table scan); the apply
 * checks the table and its foreign key are in place.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");
const FILE = path.join(__dirname, "..", "prisma", "migrations", "20261116120000_mom_announcement", "migration.sql");

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
    adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL! }),
  } as any);

  const state = async () => {
    const table: any = await db.$queryRawUnsafe(`SELECT to_regclass('"MoMAnnouncement"')::text AS t;`);
    const fk: any = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'MoMAnnouncement_matchId_fkey';`,
    );
    return { table: table[0].t ?? "MISSING", fk: fk[0].n };
  };

  // The posted announcements, for the operator's information, counted ONCE
  // and with no full-table scan (round 6 of the review): the matches with
  // MoMVote rows first, then their claim keys by `key = ANY(...)` (the
  // unique index), as `src/lib/mom-records.ts` reads them.
  const ids: Array<{ matchId: string }> = await db.$queryRawUnsafe(`SELECT DISTINCT "matchId" FROM "MoMVote";`);
  const posted: any = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "SentNotification" WHERE key = ANY($1::text[]);`,
    ids.map((r) => `${r.matchId}:mom-announcement`),
  );

  const todo = statements(readFileSync(FILE, "utf8"));
  const before = await state();
  console.log(`BEFORE: MoMAnnouncement=${before.table}  FK=${before.fk}/1  (MoM announcement claims: ${posted[0].n})`);
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
  console.log(`AFTER:  MoMAnnouncement=${after.table}  FK=${after.fk}/1`);
  if (after.table === "MISSING" || after.fk !== 1) throw new Error("MoMAnnouncement is not complete");
  console.log("table and foreign key in place (the migration only creates them)");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
