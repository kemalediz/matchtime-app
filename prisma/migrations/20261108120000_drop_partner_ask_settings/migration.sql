-- Drop the retired partner-ask settings and the automatic pool ask
-- (Kemal, 2026-11-08): "If it is enabled for a club, it is enabled for all,
-- no automatic calling or anything. It is either on or off."
--
-- An ACTIVE "ClubPartnership" is now the one switch: its organisers may ask
-- that partner (and the player pool) whenever they like, and nothing asks
-- by itself. These three columns are no longer read or written by any code.
--
-- ============================================================================
-- DESTRUCTIVE. APPLY ONLY WITH KEMAL'S EXPLICIT OK, AND ONLY AFTER THE DEPLOY.
-- ============================================================================
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. The order matters: deploy
-- the code first. The new code no longer has these fields on the Prisma
-- model, and Prisma ignores columns it does not know, so the live database
-- is safe with the columns still present while the old deployment (which
-- still reads them) drains. Apply this file by hand AFTER the deploy, once
-- no old deployment is serving:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261108120000_drop_partner_ask_settings/migration.sql
--
-- WARNING ON `prisma db push`: this repo manages schema with `db push`. Now
-- that the schema no longer has these fields, a `db push` against prod would
-- propose dropping the same columns (it asks for --accept-data-loss). Do not
-- accept that; apply this reviewed file instead, after the backup below.
--
-- WHAT IT DROPS
-- -------------
--   "Organisation"."partnerAskWhen"  TEXT NOT NULL DEFAULT 'off'
--       with CHECK "Organisation_partnerAskWhen_check" ('off', 'on-request', 'auto')
--   "Organisation"."partnerAskTime"  TEXT NULL
--       with CHECK "Organisation_partnerAskTime_check" (HH:MM)
--   "Organisation"."poolAutoAsk"     BOOLEAN NOT NULL DEFAULT false
-- Added by prisma/migrations/20261016180000_partner_clubs (the first two)
-- and prisma/migrations/20261024200000_local_player_pool (the third). The
-- two CHECKs were also re-applied by prisma/sql/partner-ask-check.sql,
-- which no longer names them. Dropping a column drops its CHECK too; the
-- explicit DROP CONSTRAINT lines below make that visible and idempotent.
-- "partnerAskCutoffHours" (the cut-off) STAYS, with its CHECK.
--
-- PROD COUNTS AT THE TIME OF THE CHANGE (as given in the brief, 2026-11-08):
--   partnerAskWhen = 'auto'             0 clubs
--   partnerAskWhen = 'on-request'       5 clubs
--   partnerAskWhen = 'off'              2 clubs (BenchTest, Sutton Lads),
--                                       neither with an active pairing
--   poolAutoAsk = true                  0 clubs
-- So no club's behaviour changes. Re-run the counts before applying:
--   SELECT "partnerAskWhen", count(*) FROM "Organisation" GROUP BY 1;
--   SELECT count(*) FROM "Organisation" WHERE "poolAutoAsk";
--   SELECT count(*) FROM "Organisation" WHERE "partnerAskTime" IS NOT NULL;
--
-- 1. BACKUP FIRST (run, and keep the output, before applying):
--   \copy (SELECT id, name, "partnerAskWhen", "partnerAskTime", "poolAutoAsk"
--          FROM "Organisation"
--          WHERE "partnerAskWhen" <> 'off' OR "partnerAskTime" IS NOT NULL OR "poolAutoAsk")
--     TO 'organisation-partner-ask-settings-backup.csv' WITH CSV HEADER
--
-- 2. APPLY this file. ONE transaction: it applies whole or not at all.
--    lock_timeout makes a busy "Organisation" table fail fast instead of
--    queueing every query behind the ALTER; if it fails on the lock,
--    nothing changed and it can simply be run again. IF EXISTS makes it
--    idempotent. Dropping a column is a catalogue change (no table
--    rewrite). There is no session-level SET in this file.
--
-- 3. VERIFY (expect 0 rows, then 1 row: partnerAskCutoffHours):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name IN ('partnerAskWhen', 'partnerAskTime', 'poolAutoAsk');
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name LIKE 'partnerAsk%';
--
-- ROLLBACK (the columns come back with their old defaults; any club's own
-- values are restorable ONLY from the step-1 backup). Restoring the columns
-- does not restore the behaviour: that needs the code back from git.
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   ALTER TABLE "Organisation"
--     ADD COLUMN IF NOT EXISTS "partnerAskWhen" TEXT NOT NULL DEFAULT 'off',
--     ADD COLUMN IF NOT EXISTS "partnerAskTime" TEXT,
--     ADD COLUMN IF NOT EXISTS "poolAutoAsk"    BOOLEAN NOT NULL DEFAULT false;
--   ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskWhen_check"
--     CHECK ("partnerAskWhen" IN ('off', 'on-request', 'auto'));
--   ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskTime_check"
--     CHECK ("partnerAskTime" IS NULL OR "partnerAskTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
--   COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation"
  DROP CONSTRAINT IF EXISTS "Organisation_partnerAskWhen_check",
  DROP CONSTRAINT IF EXISTS "Organisation_partnerAskTime_check";

ALTER TABLE "Organisation"
  DROP COLUMN IF EXISTS "partnerAskWhen",
  DROP COLUMN IF EXISTS "partnerAskTime",
  DROP COLUMN IF EXISTS "poolAutoAsk";

COMMIT;
