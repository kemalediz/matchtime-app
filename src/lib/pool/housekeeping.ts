/**
 * THE POOL'S DAILY HOUSEKEEPING (slice L2), run by the daily cron
 * (src/app/api/cron/close-ratings): a sign-up never confirmed on WhatsApp is
 * deleted POOL_RETENTION.pendingExpiryDays after it was made (its sports and
 * hours cascade), and rate-limit records after POOL_CONFIRM.attemptKeepDays.
 * The consent record is NOT touched here: it is kept for
 * POOL_RETENTION.consentRecordYears (a later retention job).
 */
import { db } from "../db";
import { attemptPurgeBefore } from "./confirm-rules";
import { pendingSignupPurgeBefore } from "./rules";

export async function poolHousekeeping(now: Date = new Date()): Promise<{ pendingDeleted: number; attemptsDeleted: number }> {
  const pending = await db.poolProfile.deleteMany({ where: { status: "pending-verify", createdAt: { lt: pendingSignupPurgeBefore(now) } } });
  const attempts = await db.poolAttempt.deleteMany({ where: { createdAt: { lt: attemptPurgeBefore(now) } } });
  if (pending.count || attempts.count) console.log(`[pool-housekeeping] pending=${pending.count} attempts=${attempts.count}`);
  return { pendingDeleted: pending.count, attemptsDeleted: attempts.count };
}
