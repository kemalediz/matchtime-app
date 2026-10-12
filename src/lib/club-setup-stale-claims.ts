/**
 * A SETUP MESSAGE THE PI TOOK AND NEVER REPORTED ON (setup-hold switch-on
 * fixes, 2026-10-13).
 *
 * A platform job is handed to the Pi by flipping it queued -> claimed
 * (`claimDuePlatformJobs`, platform-jobs.ts), and it leaves "claimed" only
 * when the Pi reports an outcome: sent, failed, or released for its
 * one-DM-a-minute pacing. THERE IS NO CLAIM TIMEOUT: a Pi that dies, or
 * loses its connection, between the claim and the report leaves the job
 * claimed for ever. Delivery is at-most-once on purpose, for every purpose.
 *
 * For a club that is setting up that is worse than one lost message. If
 * the lost job is the setup DM, the organiser was never told they are
 * approved or how to go live; the 24-hour reminder waits for the setup DM
 * to have been sent (club-setup-reminder.ts), so it never goes either; and
 * /admin/clubs shows the message as on its way, for ever.
 *
 * WHAT THIS DOES: it makes that visible, once. A job of one of the setup
 * purposes that has been claimed for more than `STALE_CLAIM_AFTER_MS` gets
 * ONE ops event for the platform owner (`SETUP_ALERT_KIND`, on
 * /admin/health), with the reason code "setup-dm-claim-stale" and which
 * message it is.
 *
 * WHAT IT DOES NOT DO: resend. The Pi may well have sent the message and
 * lost only the report, and a second "you're approved" is worse than a
 * visible alert. The owner decides (the organiser can still go live from
 * the settings page; "Go live now" on the clubs page tells them).
 *
 * Run by the 15-minute learn-setup cron. With no such job it is one query
 * that finds nothing. Logs carry ids and codes only.
 */
import { db } from "./db";
import { SETUP_ASK_DM_PURPOSE } from "./club-setup-dm-rules";
import { SETUP_ADMIN_CODE_DM_PURPOSE, SETUP_REMINDER_DM_PURPOSE } from "./club-setup-followup-rules";
import { SETUP_ALERT_KIND, recordOpsEvent } from "./ops-alerts";

/** The reason code on the ops event. */
export const STALE_CLAIM_REASON = "setup-dm-claim-stale";

/**
 * Claimed this long with no outcome: something went wrong. Far longer than
 * a healthy Pi holds a job (it sends or releases within the minute), and
 * as long as one run of the cron that looks.
 */
export const STALE_CLAIM_AFTER_MS = 15 * 60 * 1000;

/** The setup messages watched: purpose, and what the owner reads. */
const WATCHED: Record<string, string> = {
  [SETUP_ASK_DM_PURPOSE]: "setup message",
  [SETUP_ADMIN_CODE_DM_PURPOSE]: "admin group command",
  [SETUP_REMINDER_DM_PURPOSE]: "setup reminder",
  // Named by their literals: importing those modules here would be a cycle
  // for nothing (club-setup-removal.ts, club-setup-owner-live.ts).
  "setup-removed": "removed-from-group message",
  "setup-owner-live": "started-for-you message",
};

/** Every setup refId is "<club id>:<what>". */
const orgIdOf = (refId: string | null): string | null => (refId && refId.includes(":") ? refId.slice(0, refId.indexOf(":")) : null);

export const MAX_STALE_CLAIMS_PER_SWEEP = 20;

export async function flagStaleSetupDmClaims(now: Date = new Date()): Promise<{ considered: number; recorded: number }> {
  const stale = await db.platformJob.findMany({
    where: {
      kind: "dm",
      status: "claimed",
      purpose: { in: Object.keys(WATCHED) },
      claimedAt: { lte: new Date(now.getTime() - STALE_CLAIM_AFTER_MS) },
    },
    orderBy: { claimedAt: "asc" },
    take: MAX_STALE_CLAIMS_PER_SWEEP,
    select: { id: true, purpose: true, refId: true, claimedAt: true },
  });
  let recorded = 0;
  for (const job of stale ?? []) {
    const orgId = orgIdOf(job.refId);
    if (!orgId) continue;
    const what = WATCHED[job.purpose] ?? "setup message";
    const wrote = await recordOpsEvent({
      orgId,
      kind: SETUP_ALERT_KIND,
      severity: "warning",
      title: "A setup message may not have been delivered",
      detail:
        `The ${what} for this club was handed to the WhatsApp bot at ${job.claimedAt?.toISOString() ?? "an unknown time"} ` +
        `and the bot never reported what became of it (${STALE_CLAIM_REASON}). It may have been sent, or lost. ` +
        `It is NOT sent again automatically, so the organiser cannot get it twice. ` +
        `Check with the organiser, or take the club live for them from the clubs page.`,
      // Once per job, ever.
      dedupeKey: `${STALE_CLAIM_REASON}:${job.id}`,
      now,
    });
    if (wrote) {
      recorded++;
      console.error(`[club-setup-stale-claims] ${orgId}: job ${job.id} (${job.purpose}) claimed and never reported; recorded (${STALE_CLAIM_REASON})`);
    }
  }
  return { considered: (stale ?? []).length, recorded };
}
