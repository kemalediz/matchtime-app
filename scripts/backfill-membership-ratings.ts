/**
 * Copy the two GLOBAL rating columns onto every membership.
 *
 *   User.seedRating  -> Membership.seedRating
 *   User.matchRating -> Membership.matchRating
 *
 * Slice 1 of MDs/club-scoped-ratings-design-2026-09-18.md section 9.
 * NOTHING reads the new columns yet, so this changes no behaviour. It
 * exists so that slice 2 can read a per-club number on the day it ships
 * and see exactly today's values.
 *
 * Run (dry by default, writes NOTHING):
 *   node --env-file=.env --import tsx scripts/backfill-membership-ratings.ts
 * Write:
 *   node --env-file=.env --import tsx scripts/backfill-membership-ratings.ts --apply
 * Verify: re-run dry. It must report "will receive seedRating 0".
 *
 * ORDER: `prisma db push` first. The columns have to exist before
 * --apply. A DRY run is safe before the push and says so: with the
 * columns absent it reports the plan as if every membership were unset,
 * which is exactly what it will be the moment they appear.
 *
 * IDEMPOTENT twice over. The planner only selects a membership whose
 * seed is unset, or whose Elo is still at the untouched default while
 * the user's has moved (src/lib/membership-rating-backfill.ts, with its
 * tests). Every UPDATE then repeats that condition in its WHERE, so a
 * concurrent write cannot be clobbered and a resumed half-finished run
 * cannot double-apply.
 *
 * ROLLBACK: User.seedRating and User.matchRating are untouched and stay
 * in the schema until slice 7, so reverting the code reverts the
 * behaviour with no data restore.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import {
  formatBackfillReport,
  planMembershipRatingBackfill,
  type BackfillRow,
} from "../src/lib/membership-rating-backfill.ts";

const APPLY = process.argv.includes("--apply");

interface RawRow {
  membershipId: string;
  userId: string;
  userName: string | null;
  orgId: string;
  orgName: string;
  leftAt: Date | null;
  userSeedRating: number | null;
  userMatchRating: number;
  membershipSeedRating: number | null;
  membershipMatchRating: number | null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set. Run with node --env-file=.env --import tsx ...");
    process.exit(1);
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  // Which of the new columns exist yet? A dry run before `prisma db
  // push` is expected and must not throw.
  const present = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Membership'
        AND column_name IN ('seedRating', 'matchRating')`,
  );
  const names = new Set(present.map((r) => r.column_name));
  const hasSeedCol = names.has("seedRating");
  const hasEloCol = names.has("matchRating");
  const columnsReady = hasSeedCol && hasEloCol;

  if (APPLY && !columnsReady) {
    console.error(
      "Membership.seedRating / Membership.matchRating do not exist yet. " +
        "Run `npx prisma db push` first, then re-run with --apply.",
    );
    await db.$disconnect();
    process.exit(1);
  }

  const seedSel = hasSeedCol
    ? `m."seedRating" AS "membershipSeedRating"`
    : `NULL::double precision AS "membershipSeedRating"`;
  const eloSel = hasEloCol
    ? `m."matchRating" AS "membershipMatchRating"`
    : `NULL::int AS "membershipMatchRating"`;

  const raw = await db.$queryRawUnsafe<RawRow[]>(
    `SELECT m."id"           AS "membershipId",
            m."userId"       AS "userId",
            u."name"         AS "userName",
            m."orgId"        AS "orgId",
            o."name"         AS "orgName",
            m."leftAt"       AS "leftAt",
            u."seedRating"   AS "userSeedRating",
            u."matchRating"  AS "userMatchRating",
            ${seedSel},
            ${eloSel}
       FROM "Membership" m
       JOIN "User" u ON u."id" = m."userId"
       JOIN "Organisation" o ON o."id" = m."orgId"
      ORDER BY o."name" ASC, u."name" ASC NULLS LAST, m."id" ASC`,
  );

  const rows: BackfillRow[] = raw.map((r) => ({
    membershipId: r.membershipId,
    userId: r.userId,
    userName: r.userName,
    orgId: r.orgId,
    orgName: r.orgName,
    leftAt: r.leftAt,
    userSeedRating: r.userSeedRating === null ? null : Number(r.userSeedRating),
    userMatchRating: Number(r.userMatchRating),
    membershipSeedRating:
      r.membershipSeedRating === null ? null : Number(r.membershipSeedRating),
    // Absent column: the value it WILL have the moment db push adds it.
    membershipMatchRating:
      r.membershipMatchRating === null ? 1000 : Number(r.membershipMatchRating),
  }));

  const plan = planMembershipRatingBackfill(rows);

  if (!APPLY) {
    console.log(formatBackfillReport(plan));
    if (!columnsReady) {
      console.log("");
      console.log(
        "NOTE: Membership.seedRating / Membership.matchRating are not in the " +
          "database yet, so every membership is reported as unset. That is the " +
          "true state. Run `npx prisma db push`, then --apply.",
      );
    }
    await db.$disconnect();
    return;
  }

  console.log("MEMBERSHIP RATING BACKFILL (APPLY)");
  console.log(`  seed writes planned: ${plan.seedWrites.length}`);
  console.log(`  Elo writes planned:  ${plan.eloWrites.length}`);

  let seedWritten = 0;
  for (const w of plan.seedWrites) {
    seedWritten += await db.$executeRaw`
      UPDATE "Membership" SET "seedRating" = ${w.value}
       WHERE "id" = ${w.membershipId} AND "seedRating" IS NULL`;
  }
  let eloWritten = 0;
  for (const w of plan.eloWrites) {
    eloWritten += await db.$executeRaw`
      UPDATE "Membership" SET "matchRating" = ${w.value}
       WHERE "id" = ${w.membershipId} AND "matchRating" = 1000`;
  }

  console.log(`  seed rows written:   ${seedWritten}`);
  console.log(`  Elo rows written:    ${eloWritten}`);
  console.log("");
  console.log("Now re-run WITHOUT --apply. It must report: will receive seedRating 0.");

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
