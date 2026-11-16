/**
 * THE TOMBSTONE'S ONE STATEMENT (2026-11-15, PR #606), on its own so a test
 * can run it against a real Postgres (`e2e/sim/message-change.spec.ts`).
 * Parameters: $1 id, $2 chatId, $3 waMessageId, $4 byAdmin, $5 reason,
 * $6 senderJids, $7 senderPhones, $8 now, $9 the change as a one-element
 * JSON array. See `recordTombstone` in `message-change.ts`.
 */

/** The most changes kept per message (deletes first). */
export const MAX_CHANGES_PER_MESSAGE = 20;

/**
 * SQL: is the change being recorded already in the row (whatever its time)?
 * Then the upsert is a no-op for the record: an outbox retry or an admin
 * re-check never moves `lastChangeAt` on or makes the tombstone due again.
 */
const SAME_CHANGE_SEEN = `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE("DeletedMessage"."changes", '[]'::jsonb)) AS seen(e) WHERE seen.e - 'at' = (EXCLUDED."changes"->0) - 'at')`;

export const TOMBSTONE_UPSERT_SQL = `INSERT INTO "DeletedMessage" ("id", "chatId", "waMessageId", "byAdmin", "reason", "senderJids", "senderPhones", "deletedAt", "lastChangeAt", "changes")
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $8, $9::jsonb)
     ON CONFLICT ("chatId", "waMessageId") DO UPDATE SET
       "byAdmin" = "DeletedMessage"."byAdmin" OR EXCLUDED."byAdmin",
       "reason" = CASE WHEN "DeletedMessage"."reason" = 'deleted' OR EXCLUDED."reason" = 'deleted' THEN 'deleted' ELSE 'edited' END,
       "senderJids" = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE("DeletedMessage"."senderJids", '{}'::text[]) || EXCLUDED."senderJids") AS x),
       "senderPhones" = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE("DeletedMessage"."senderPhones", '{}'::text[]) || EXCLUDED."senderPhones") AS x),
       "changes" = (
         SELECT COALESCE(jsonb_agg(k.e ORDER BY k.o), '[]'::jsonb) FROM (
           SELECT u.e, u.o FROM (
             SELECT a.e, a.o, row_number() OVER (PARTITION BY a.e - 'at' ORDER BY a.o) AS n
             FROM jsonb_array_elements(COALESCE("DeletedMessage"."changes", '[]'::jsonb) || EXCLUDED."changes") WITH ORDINALITY AS a(e, o)
           ) u
           WHERE u.n = 1
           ORDER BY (u.e->>'reason' = 'deleted') DESC, u.o
           LIMIT ${MAX_CHANGES_PER_MESSAGE}
         ) k
       ),
       "lastChangeAt" = CASE WHEN ${SAME_CHANGE_SEEN} THEN "DeletedMessage"."lastChangeAt" ELSE GREATEST("DeletedMessage"."lastChangeAt", EXCLUDED."lastChangeAt") END,
       "enforcedAt" = CASE WHEN ${SAME_CHANGE_SEEN} THEN "DeletedMessage"."enforcedAt" ELSE NULL END
     RETURNING "byAdmin", "reason", "senderJids", "senderPhones", "deletedAt", "changes"`;
