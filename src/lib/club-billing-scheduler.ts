/**
 * CLUB FEE BILLING, slice B4: the hourly scheduler (`/api/cron/billing`).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.1 and 6.
 *
 * Every run:
 *   1. voids any unpaid club fee invoice of a club that must not be
 *      charged any more (set Free, exempt, gone), whatever the flag says,
 *      so Stripe's own retries never take it (`sweepUnwantedMonthInvoices`,
 *      slice P2; it replaces B3's refund-intent sweep, which went with the
 *      subscription);
 *   2. with BILLING_ENABLED on, for every billed club that is approved and
 *      came through self-join (never a suspended, unapproved, exempt or
 *      pre self-join club):
 *        a. the state change that is due, ON TIME at any hour: the free
 *           month ends (to grace), the grace week ends (to paused). Through
 *           the one locked writer `setBillingState`, so a webhook arriving
 *           at the same moment is serialised and the second one decides on
 *           fresh state (a card added a second earlier wins);
 *        b. in the daytime only (10:00 to 20:00 London): the billing
 *           contact's day 21, 28, 30 or "paused" DM, the admins' club fee
 *           tip, and every pending billing DM that is still true.
 *
 * Why a Vercel cron and not the Pi scheduler: the Pi stops polling a paused
 * club, and the day 37 DM must go out after the pause. The platform DM
 * channel works whatever a club's switches say. Hourly runs make a missed
 * run harmless: every step is claimed once.
 *
 * Nothing here ever DMs the platform owner. Problems go to /admin/health.
 */
import { db } from "./db";
import { setBillingState } from "./club-billing";
import { APPROVED_CLUB_WHERE, isClubApproved } from "./club-approval-state";
import { isBillingEnabled } from "./club-billing-rules";
import { billingTransitionDue, isBillingDmHour } from "./club-billing-schedule-rules";
import { flushPendingBillingDms, sendClubFeeTip, sendScheduledBillingDms } from "./club-billing-dms";
import { flushPendingBillingNotices } from "./club-billing-stripe";
import { sweepUnwantedMonthInvoices } from "./club-billing-months";

export interface BillingCronClubReport {
  orgId: string;
  transition?: string;
  dms?: string[];
  feeTip?: string;
  pendingSent?: number;
  error?: string;
}

export interface BillingCronReport {
  enabled: boolean;
  daytime: boolean;
  /** Slice P2: unpaid invoices of clubs no longer billed, voided. */
  voids: { voided: number; failed: number } | { error: string };
  clubs: BillingCronClubReport[];
}

export async function runBillingCron(now: Date = new Date()): Promise<BillingCronReport> {
  let voids: BillingCronReport["voids"];
  try {
    voids = await sweepUnwantedMonthInvoices(now);
  } catch (err) {
    voids = { error: err instanceof Error ? err.message : String(err) };
    console.error("[billing-cron] void sweep failed:", err);
  }
  const daytime = isBillingDmHour(now);
  if (!isBillingEnabled()) return { enabled: false, daytime, voids, clubs: [] };

  // Every club with a ClubBilling row (only billed clubs have one), of the
  // approved ones. The billing state is read through a select and decided
  // in code: the gate column is never filtered on outside the gate helpers.
  const rows = await db.clubBilling.findMany({
    where: { org: APPROVED_CLUB_WHERE },
    select: { orgId: true, org: { select: { approvalStatus: true, approvedAt: true, billingStatus: true } } },
  });

  const clubs: BillingCronClubReport[] = [];
  for (const row of rows) {
    if (!isClubApproved(row.org) || row.org.approvedAt === null || row.org.billingStatus === "exempt") continue;
    const report: BillingCronClubReport = { orgId: row.orgId };
    clubs.push(report);
    try {
      // The state change, on time. Read fresh: the ClubBilling dates are
      // needed, and the writer decides again under the lock anyway.
      const fresh = await db.clubBilling.findUnique({
        where: { orgId: row.orgId },
        select: { trialEndsAt: true, graceEndsAt: true, pausedAt: true, pausedReason: true },
      });
      if (fresh) {
        const due = billingTransitionDue({ status: row.org.billingStatus, ...fresh }, now);
        if (due) {
          const r = await setBillingState(row.orgId, { type: due }, now);
          report.transition = r.ok ? `${r.from}->${r.to}` : `${due}:${r.reason}`;
        }
      }
      if (daytime) {
        report.dms = await sendScheduledBillingDms(row.orgId, now);
        report.feeTip = await sendClubFeeTip(row.orgId, now);
        report.pendingSent = (await flushPendingBillingDms(row.orgId, now)) + (await flushPendingBillingNotices(row.orgId, now));
      }
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
      console.error(`[billing-cron] ${row.orgId} failed:`, err);
    }
  }
  console.log(`[billing-cron] ${now.toISOString()}: ${clubs.length} billed club(s), daytime ${daytime}`);
  return { enabled: true, daytime, voids, clubs };
}
