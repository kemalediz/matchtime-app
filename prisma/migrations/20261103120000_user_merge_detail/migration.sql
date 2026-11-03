-- The audit detail of a person merge (2026-11-03).
-- When two Users turn out to be the same person (FNF's "Uncle Najib" is
-- Sutton Football Club's "Najib"), src/lib/user-merge.ts folds the source
-- into the target and records it in "UserMerge". This column holds what
-- moved: counts per table, every unique-key conflict and how it was
-- settled, and every row written.
--
-- The code never selects this column through Prisma (@ignore), so this may
-- be applied before or after the code is deployed. It MUST be applied
-- before scripts/_tmp-merge-users.ts --apply is run: the merge writes the
-- detail in its own transaction, so without the column the whole merge
-- rolls back and nothing is written.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261103120000_user_merge_detail/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One new NULLABLE column on "UserMerge", no default,
-- so adding it rewrites no rows and takes only a brief lock.
--   * "UserMerge"."detail"  JSONB NULL
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; a second run changes nothing.
-- ONE transaction; there is no session-level SET in this file.
--
-- Verify after applying (expect one row):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'UserMerge' AND column_name = 'detail';
--
-- Rolling back:
--   ALTER TABLE "UserMerge" DROP COLUMN IF EXISTS "detail";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserMerge" ADD COLUMN IF NOT EXISTS "detail" JSONB;

COMMIT;
