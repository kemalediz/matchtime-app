/**
 * The player pool's platform switch in the e2e database (2026-10-28): the
 * `PlatformSetting` row "pool-offers" the owner flips on /admin/clubs. The
 * suite's database starts with no row (`prisma db push` creates the table,
 * not the migration's row), which reads as OFF, like the old unset
 * environment variable. A spec that needs the club's pool cards turns it on.
 */
import type { TestDb } from "./test-db";

export async function setPoolPlatform(db: TestDb, on: boolean): Promise<void> {
  await db.run(
    `INSERT INTO "PlatformSetting" (key, "on", "updatedAt") VALUES ('pool-offers', $1, now())
     ON CONFLICT (key) DO UPDATE SET "on" = EXCLUDED."on", "updatedAt" = now()`,
    [on],
  );
}

export async function poolPlatformOn(db: TestDb): Promise<boolean> {
  const row = await db.one<{ on: boolean }>(`SELECT "on" FROM "PlatformSetting" WHERE key = 'pool-offers'`);
  return row?.on === true;
}
