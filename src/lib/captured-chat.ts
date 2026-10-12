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
 * TWO RULES, and this file is where both are kept:
 *
 *   1. Wherever one is deleted, the other is deleted in the same
 *      statement.
 *   2. A late write (a re-add of a group already linked) lands only on a
 *      request that is STILL linked with MatchTime still in the group. A
 *      request cleared a moment earlier by a removal, a rejection or an
 *      approval is never written again.
 *
 * So EVERY statement and every `data:` fragment that writes either column
 * lives in this file, and the call sites only say when:
 *
 *   stored   - the group is linked            group-add.ts `linkGroupToRequest`
 *            - a re-add brings what was missing  group-add.ts (already linked)
 *   deleted  - MatchTime is removed from the group   group-add.ts `handleBotRemoved`
 *            - the club is rejected                  club-approval.ts `decideClub`
 *            - the learned setup has read the chat   setup-learning/run.ts
 *            - the club went live with a reading unfinished   club-setup.ts
 *            - it is 7 days old and unread           captured-history-expiry.ts
 *
 * src/lib/__tests__/captured-chat.test.ts is a source guard over src/ and
 * scripts/: outside this file the two names may only be READ (a property
 * read, a Prisma `select`, a type). A new place that stores or deletes
 * captured chat must call one of these, and so cannot leave the
 * description behind or write to a cleared request.
 *
 * (The legacy in-group setup keeps its own copy of the chat on
 * OnboardingSession. It never stored a description; its writes are here
 * too, so the guard has no exception to carry.)
 *
 * Raw SQL on purpose: none of these ever SELECTs or RETURNs what it
 * touches, so the text never enters this process on its way out.
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
 * Delete the captured chat and description of every connect request of
 * one club (the club went live while its reading was unfinished).
 */
export async function clearCapturedChatForClub(client: RawSqlClient, orgId: string): Promise<number> {
  return client.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL WHERE "orgId" = ${orgId}`;
}

/**
 * What a LINK writes, as a fragment for the link's own `data`: the chat
 * the add brought and the description (already masked by
 * `ingestGroupDescription`). A key is left out when there is nothing to
 * store, so a stored value is never overwritten with nothing.
 */
export function capturedAtLink(c: { history: readonly unknown[]; description: string | null }): {
  capturedHistory?: object;
  capturedDescription?: string;
} {
  return {
    ...(c.history.length > 0 ? { capturedHistory: c.history as unknown as object } : {}),
    ...(c.description ? { capturedDescription: c.description } : {}),
  };
}

/**
 * A RE-ADD of a group that is already linked may bring what the first add
 * could not. Each is stored only where NONE is stored (it never replaces),
 * and only while the request is still linked and MatchTime is still in the
 * group: the caller read the request a moment ago, and a removal, a
 * rejection or an approval may have cleared it since. Each of those moves
 * `status` off 'group_linked' or sets `botRemovedAt` in the transaction
 * that clears, so this one statement cannot write to a cleared request.
 * `description` must already be masked.
 */
export async function fillCapturedChatOnReAdd(
  client: RawSqlClient,
  connectId: string,
  c: { history: readonly unknown[]; description: string | null },
): Promise<{ history: number; description: number }> {
  let history = 0;
  let description = 0;
  if (c.history.length > 0) {
    history = await client.$executeRaw`UPDATE "ClubConnect" SET "capturedHistory" = ${JSON.stringify(c.history)}::jsonb
      WHERE "id" = ${connectId} AND "capturedHistory" IS NULL
        AND "status" = 'group_linked' AND "botRemovedAt" IS NULL`;
  }
  if (c.description) {
    description = await client.$executeRaw`UPDATE "ClubConnect" SET "capturedDescription" = ${c.description}
      WHERE "id" = ${connectId} AND "capturedDescription" IS NULL
        AND "status" = 'group_linked' AND "botRemovedAt" IS NULL`;
  }
  return { history, description };
}

/**
 * The legacy in-group setup's chat, as a fragment for an OnboardingSession
 * `data`. Nothing when there is none: a session's chat is never replaced
 * with nothing.
 */
export function capturedSessionChat(history: object | undefined): { capturedHistory?: object } {
  return history ? { capturedHistory: history } : {};
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
