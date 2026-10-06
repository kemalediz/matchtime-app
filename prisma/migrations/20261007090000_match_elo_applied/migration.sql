-- What the Elo pass did for a match, stored with the match (2026-10-07).
--
-- WHY
-- ---
-- On 6 October 2026 Sutton FC's result was recorded the wrong way round
-- and could not simply be re-entered: the points a score adds to each
-- player's club Elo were not stored anywhere, so a changed score added
-- the new result's points on top of the old one's. `lib/match-elo.ts`
-- now reverses the old points before applying the new, and it reads them
-- from this column.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * "Match"."eloApplied" JSONB NULL. Shape:
--       { "red": int, "yellow": int,
--         "deltas": [{ "userId": text, "delta": int }] | null }
--     NULL on every existing row. Adding a nullable column with no
--     default does not rewrite the table.
--   * ONE row is filled in: the Sutton FC match of 6 October 2026
--     (cmtbro2ct0006tt9kxjbbr0ce). Its ratings were corrected by hand
--     that night (scripts/fix-score-2026-10-06.ts, candidate [0]), so
--     what its result contributed is known exactly: each of the seven
--     Red players -27 and each of the seven Yellow players +27, for
--     Red 6, Yellow 9. The UPDATE is guarded on the match still reading
--     Red 6, Yellow 9 and on the column being empty, so if anybody has
--     edited the score since, it changes nothing and that match is
--     treated like any other older match (below).
--
-- MATCHES SCORED BEFORE THIS COLUMN EXISTED
-- -----------------------------------------
-- They stay NULL and nothing about them changes until somebody edits
-- their score. Then the code stamps { red, yellow, deltas: null } with
-- the OLD score in the same write, meaning "the ratings reflect this
-- score and what was written is unknown", and tries to work the points
-- out backwards. It only does that when no later match of the club has
-- been scored; otherwise it leaves the ratings alone, keeps the stamp,
-- and says so in the log. It never adds a second result's points on top.
--
-- DEPLOY ORDER: APPLY THIS BEFORE THE CODE THAT READS THE COLUMN.
-- The old code never mentions the column, so applying first is safe.
-- The new code selects it on every score write and would fail without it.
--
-- Verify after applying:
--   SELECT count(*) FROM "Match" WHERE "eloApplied" IS NOT NULL;   -- expect 1
--   SELECT jsonb_array_length("eloApplied"->'deltas') FROM "Match"
--    WHERE id = 'cmtbro2ct0006tt9kxjbbr0ce';                       -- expect 14
--
-- Rolling back (only before the new code is deployed):
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   ALTER TABLE "Match" DROP COLUMN IF EXISTS "eloApplied";
--   COMMIT;
--
-- NOT APPLIED BY THIS PR. This repo syncs schema with `prisma db push`, but
-- production gets THIS file (psql -f; it carries its own BEGIN/COMMIT).
-- lock_timeout makes a busy table fail the migration instead of queueing
-- behind it and blocking the bot's writes.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "eloApplied" JSONB;

UPDATE "Match"
   SET "eloApplied" = jsonb_build_object(
         'red', 6,
         'yellow', 9,
         'deltas', (
           SELECT jsonb_agg(jsonb_build_object(
                    'userId', ta."userId",
                    'delta', CASE WHEN ta."team" = 'RED' THEN -27 ELSE 27 END
                  ) ORDER BY ta."userId")
             FROM "TeamAssignment" ta
            WHERE ta."matchId" = 'cmtbro2ct0006tt9kxjbbr0ce'
         )
       )
 WHERE "id" = 'cmtbro2ct0006tt9kxjbbr0ce'
   AND "redScore" = 6
   AND "yellowScore" = 9
   AND "eloApplied" IS NULL
   -- The fourteen players the correction was applied to. If the team
   -- sheet has changed since, do not pretend to know.
   AND (SELECT count(*) FROM "TeamAssignment" ta
         WHERE ta."matchId" = 'cmtbro2ct0006tt9kxjbbr0ce') = 14;

COMMIT;
