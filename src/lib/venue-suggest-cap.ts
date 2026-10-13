/**
 * THE PER-PERSON CAP ON VENUE SUGGESTION CALLS (2026-10-13).
 *
 * `claimSuggestCall` is asked by /api/venue/suggest before every call
 * that would reach Google. It counts the call against the signed-in
 * person's clock hour and answers whether it may go ahead:
 * `VENUE_SUGGEST_CALLS_PER_USER_PER_HOUR` an hour, then no more until
 * the next hour.
 *
 * Why per person and in the database: /create-org has no club yet, so
 * the per-club `VenueLookup` cap cannot count these, and the app runs on
 * many short-lived server instances, so a counter in memory would count
 * nothing.
 *
 * One row per person per hour (`VenueSuggestUsage`), incremented by one
 * atomic upsert on its single-column key, so calls arriving together are
 * each counted. A refused call is counted too; that changes nothing.
 *
 * IT FAILS CLOSED AND NEVER THROWS. If the count cannot be kept (the
 * table is not there yet, the database is busy), the answer is "no":
 * suggestions switch off and the venue box is a plain text box. Nothing
 * else depends on this, least of all creating a club.
 *
 * The row holds a user id, an hour and a count. Never what was typed.
 */
import { db } from "./db";
import { VENUE_SUGGEST_CALLS_PER_USER_PER_HOUR, suggestWindowStart } from "./venue-suggest-rules";

export async function claimSuggestCall(userId: string, now: Date = new Date()): Promise<boolean> {
  if (!userId) return false;
  const windowStart = suggestWindowStart(now);
  const key = `${userId}|${windowStart.toISOString()}`;
  try {
    const row = await db.venueSuggestUsage.upsert({
      where: { key },
      create: { key, userId, windowStart, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    if (row.count === 1) {
      // The first call of a new hour: this person's earlier hours are done with.
      await db.venueSuggestUsage.deleteMany({ where: { userId, windowStart: { lt: windowStart } } }).catch(() => undefined);
    }
    return row.count <= VENUE_SUGGEST_CALLS_PER_USER_PER_HOUR;
  } catch (err) {
    // The name only: a database error's message can carry SQL.
    console.error(`[venue-suggest] cap could not be counted (${(err as Error)?.name ?? "error"})`);
    return false;
  }
}
