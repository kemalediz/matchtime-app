/**
 * THE POOL'S DAILY HOUSEKEEPING (slice L2), run by the daily cron
 * (src/app/api/cron/close-ratings): a sign-up never confirmed on WhatsApp is
 * deleted POOL_RETENTION.pendingExpiryDays after it was made (its sports and
 * hours cascade), and rate-limit records after POOL_CONFIRM.attemptKeepDays.
 * The consent record is NOT touched here: it is kept for
 * POOL_RETENTION.consentRecordYears (a later retention job).
 * Slice L7: block and report records 24 months after the profile they are
 * about was deleted (decision L0.3, `safety.ts` `purgeSafetyRecords`).
 */
import { db } from "../db";
import { attemptPurgeBefore } from "./confirm-rules";
import { pendingSignupPurgeBefore } from "./rules";
import { purgeSafetyRecords } from "./safety";

export async function poolHousekeeping(
  now: Date = new Date(),
): Promise<{ pendingDeleted: number; attemptsDeleted: number; blocksDeleted: number; reportsDeleted: number }> {
  const pending = await db.poolProfile.deleteMany({ where: { status: "pending-verify", createdAt: { lt: pendingSignupPurgeBefore(now) } } });
  const attempts = await db.poolAttempt.deleteMany({ where: { createdAt: { lt: attemptPurgeBefore(now) } } });
  const safety = await purgeSafetyRecords(now);
  if (pending.count || attempts.count || safety.blocks || safety.reports) {
    console.log(`[pool-housekeeping] pending=${pending.count} attempts=${attempts.count} blocks=${safety.blocks} reports=${safety.reports}`);
  }
  return { pendingDeleted: pending.count, attemptsDeleted: attempts.count, blocksDeleted: safety.blocks, reportsDeleted: safety.reports };
}
