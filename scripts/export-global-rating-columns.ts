/**
 * READ-ONLY. Dump `User.seedRating` and `User.matchRating` for every user
 * to a JSON file, so slice 7's `prisma db push` has a backup behind it.
 *
 *   node --env-file=.env --import tsx scripts/export-global-rating-columns.ts [outfile]
 *
 * RUN IT BEFORE THE PUSH. `db push` DROPS a column removed from the
 * schema and there is no undo short of a database restore. This file is
 * the cheap undo: it is the entire contents of both columns, keyed by
 * user id, and the whole of what slice 1's backfill was ever computed
 * from.
 *
 * ORDER, because it matters:
 *   1. Merge and deploy slice 7, so the deployed Prisma client stops
 *      SELECTing the two columns.
 *   2. Run this. Check the counts it prints.
 *   3. `npx prisma db push`.
 *   4. Verify, and keep the file.
 *
 * WHY RAW SQL. This script is in the same commit that removes both
 * fields from `prisma/schema.prisma`, so the generated client no longer
 * knows they exist and `db.user.findMany({ select: { seedRating: true }})`
 * would not compile. The columns are still in the DATABASE until the
 * push, which is exactly the window this runs in, so it asks Postgres
 * directly. That also makes it honest after the push: the columns are
 * gone, the query fails, and it says so rather than writing an empty
 * backup over a good one.
 *
 * WRITES NOTHING to the database. One SELECT, one local file.
 *
 * THE FILE CONTAINS PLAYER NAMES. Keep it off GitHub; the default
 * filename is covered by .gitignore.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { writeFileSync } from "node:fs";
import path from "node:path";

interface UserRatingRow {
  id: string;
  name: string | null;
  seedRating: number | null;
  matchRating: number | null;
}

const DEFAULT_MATCH_RATING = 1000;

function defaultOutfile(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return path.resolve(process.cwd(), `user-global-ratings-backup-${stamp}.json`);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set. Run with node --env-file=.env --import tsx ...");
    process.exit(1);
  }
  const outfile = process.argv[2] ? path.resolve(process.argv[2]) : defaultOutfile();
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  // Refuse to write a misleading backup. If the push has already
  // happened, say so instead of producing a file of nulls.
  const present = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'User'
        AND column_name IN ('seedRating', 'matchRating')`,
  );
  const names = new Set(present.map((r) => r.column_name));
  const missing = ["seedRating", "matchRating"].filter((c) => !names.has(c));
  if (missing.length > 0) {
    console.error(
      `"User".${missing.join(' and "User".')} ${missing.length > 1 ? "are" : "is"} ` +
        "no longer in this database, so there is nothing left to back up.\n" +
        "This script only runs BEFORE `prisma db push` drops them. If the push " +
        "has already happened, the data is in a database backup or nowhere.",
    );
    await db.$disconnect();
    process.exit(1);
  }

  const raw = await db.$queryRawUnsafe<UserRatingRow[]>(
    `SELECT "id", "name", "seedRating", "matchRating"
       FROM "User"
      ORDER BY "id" ASC`,
  );

  // Postgres hands `double precision` back as a JS number already, but
  // an `Int` can arrive as a BigInt depending on the driver. Normalise
  // both so the JSON is plain numbers and not "1000n".
  const users: UserRatingRow[] = raw.map((r) => ({
    id: r.id,
    name: r.name,
    seedRating: r.seedRating === null ? null : Number(r.seedRating),
    matchRating: r.matchRating === null ? null : Number(r.matchRating),
  }));

  const withSeed = users.filter((u) => u.seedRating !== null).length;
  const movedElo = users.filter(
    (u) => u.matchRating !== null && u.matchRating !== DEFAULT_MATCH_RATING,
  ).length;

  const payload = {
    exportedAt: new Date().toISOString(),
    source: 'User.seedRating and User.matchRating, read with raw SQL before slice 7\'s `prisma db push`',
    design: "MDs/club-scoped-ratings-design-2026-09-18.md, slice 7",
    columns: ["id", "name", "seedRating", "matchRating"],
    userCount: users.length,
    usersWithSeedRating: withSeed,
    usersWithMovedMatchRating: movedElo,
    users,
  };

  writeFileSync(outfile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log("USER GLOBAL RATING COLUMNS EXPORTED (read-only, nothing written to the DB)");
  console.log(`  users                          ${String(users.length).padStart(5)}`);
  console.log(`  with a seedRating              ${String(withSeed).padStart(5)}`);
  console.log(`  with a matchRating off 1000    ${String(movedElo).padStart(5)}`);
  console.log(`  file                           ${outfile}`);
  console.log("");
  console.log("Safe to run `npx prisma db push` once this file is somewhere you can find it.");

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
