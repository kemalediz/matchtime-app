/**
 * WHAT WHATSAPP SHARED AT THE ADD IS DELETED TOGETHER (2026-10-12).
 *
 * A connect request keeps two things the Pi sent when MatchTime was added
 * to the group, both only until they have been read or are no longer
 * wanted:
 *
 *   ClubConnect.capturedHistory      the group's recent chat;
 *   ClubConnect.capturedDescription  the group's description, with numbers
 *                                    masked out (src/lib/group-description.ts).
 *
 * THE RULE: wherever one is deleted, the other is deleted in the same
 * statement. So EVERY statement that deletes either lives in this file,
 * and the call sites only say when:
 *
 *   - MatchTime is removed from the group   group-add.ts `handleBotRemoved`
 *   - the club is rejected                  club-approval.ts `decideClub`
 *   - the learned setup has read the chat   setup-learning/run.ts
 *   - it is 7 days old and unread           captured-history-expiry.ts
 *
 * src/lib/__tests__/captured-chat.test.ts is a source guard: no other file
 * under src/ may set either column to NULL, in SQL or through Prisma. A
 * new place that deletes captured chat must call one of these, and so
 * cannot leave the description behind.
 *
 * (The legacy in-group setup keeps its own copy of the chat on
 * OnboardingSession. It never stored a description; its one deleting
 * statement is here too, so the guard has no exception to carry.)
 *
 * Raw SQL on purpose: none of these ever SELECTs or RETURNs what it
 * deletes, so the text never enters this process on its way out.
 */

/** `db`, or the client a `db.$transaction` callback is handed. */
export interface RawSqlClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
}

/** Delete one connect request's captured chat and description. */
export async function clearCapturedChat(client: RawSqlClient, connectId: string): Promise<number> {
  return client.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL WHERE "id" = ${connectId}`;
}

/**
 * The 7-day expiry for connect requests (the rule and its cut-offs are in
 * captured-history-expiry.ts). A request that holds only a description
 * expires exactly like one that holds chat. Bounded by `limit`; returns
 * how many requests were cleared. The times are UTC strings cast to
 * `timestamp`: see `utcTimestamp` there.
 */
export async function clearExpiredCapturedChat(
  client: RawSqlClient,
  cut: { expireBefore: string; sweepReadsSince: string; limit: number },
): Promise<number> {
  return client.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL
    WHERE "id" IN (
      SELECT c."id" FROM "ClubConnect" c
      JOIN "Organisation" o ON o."id" = c."orgId"
      WHERE (c."capturedHistory" IS NOT NULL OR c."capturedDescription" IS NOT NULL)
        AND COALESCE(c."linkedAt", c."createdAt") < ${cut.expireBefore}::timestamp
        AND (o."approvedAt" IS NULL OR o."approvedAt" < ${cut.sweepReadsSince}::timestamp)
      ORDER BY c."id"
      LIMIT ${cut.limit}
    )`;
}

/** The same expiry for the legacy in-group setup's copy of the chat. */
export async function clearExpiredSessionChat(
  client: RawSqlClient,
  cut: { expireBefore: string; limit: number },
): Promise<number> {
  return client.$executeRaw`UPDATE "OnboardingSession" SET "capturedHistory" = NULL
    WHERE "id" IN (
      SELECT s."id" FROM "OnboardingSession" s
      WHERE s."capturedHistory" IS NOT NULL
        AND (s."stage" IN ('completed', 'abandoned') OR s."createdAt" < ${cut.expireBefore}::timestamp)
      ORDER BY s."id"
      LIMIT ${cut.limit}
    )`;
}
