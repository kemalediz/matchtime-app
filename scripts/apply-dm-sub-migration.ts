import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);

  const optedOut = await db.membership.count({ where: { ratingDmOptOut: true } });
  const total = await db.membership.count();
  console.log(`Before: ${total} memberships, ${optedOut} with ratingDmOptOut=true`);

  if (!APPLY) { console.log("(dry-run — pass --apply)"); await db.$disconnect(); return; }

  // 1. Additive columns, idempotent. All default true (subscribed).
  await db.$executeRawUnsafe(`
    ALTER TABLE "Membership"
      ADD COLUMN IF NOT EXISTS "subBenchOfferDm"  BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "subMatchInviteDm" BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "subRatingDm"      BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "subReminderDm"    BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "subTentativeDm"   BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "subPrefsUpdatedAt" TIMESTAMP(3);
  `);
  console.log("Columns added (or already present).");

  // 2. Backfill: preserve existing rating opt-outs. subRatingDm = NOT ratingDmOptOut.
  const res = await db.$executeRawUnsafe(`
    UPDATE "Membership"
    SET "subRatingDm" = FALSE,
        "subPrefsUpdatedAt" = COALESCE("ratingDmOptOutAt", NOW())
    WHERE "ratingDmOptOut" = TRUE AND "subRatingDm" = TRUE;
  `);
  console.log(`Backfill: set subRatingDm=false on ${res} row(s).`);

  const rows = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Membership" WHERE "subRatingDm" = FALSE;`,
  );
  const nowOff = (rows as Array<{ n: number }>)[0].n;
  console.log(`After: ${nowOff} memberships with subRatingDm=false (should equal ${optedOut}).`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
