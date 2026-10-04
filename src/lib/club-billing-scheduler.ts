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
 *        b. slice P3: the club's CURRENT billing month is opened if it is
 *           not yet, at any hour (`openDueMonths`: only the month
 *           containing now, never an earlier one, so no catch-up);
 *        c. in the daytime only (10:00 to 20:00 London):
 *             - slice P3: the club's lowest month that ended at least 6
 *               hours ago is closed: counted, and charged or recorded why
 *               not (`closeNextDueMonth`, a compare-and-set: one month per
 *               club per run, and two runs never both charge it);
 *             - slice P3: the cron's own retries of a failed month's
 *               invoice, days 1, 3 and 5 (BILLING_CRON_RETRIES, default
 *               OFF since Stripe's own retries cover one-off invoices); a
 *               paid retry is applied at once;
 *             - the billing contact's day 21, 28, 30 or "paused" DM, the
 *               admins' club fee tip, every pending billing DM that is
 *               still true, and (slice P3) the month DMs: the receipt of a
 *               paid month, "nothing to pay" for the first month in a row
 *               with no games.
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
import { billingTransitionDue, bothRetrySourcesOn, isBillingDmHour } from "./club-billing-schedule-rules";
import { BILLING_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { flushPendingBillingDms, sendClubFeeTip, sendMonthDms, sendScheduledBillingDms } from "./club-billing-dms";
import { flushPendingBillingNotices, syncPaidMonthInvoice } from "./club-billing-stripe";
import { closeNextDueMonth, openDueMonths, retryFailedMonthInvoices, sweepUnwantedMonthInvoices } from "./club-billing-months";
import { recordBillingFlagState } from "./club-billing-spells";

export interface BillingCronClubReport {
  orgId: string;
  transition?: string;
  /** Slice P3: month(s) opened this run. */
  opened?: number[];
  /** Slice P3: the month closed this run, "<index>:<outcome>", or why not. */
  closed?: string;
  /** Slice P3: the cron's retries, "<index>:d<day>:<outcome>". */
  retries?: string[];
  /** Slice P3: the month DMs queued, "<kind>:<index>". */
  monthDms?: string[];
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
  // H1: BILLING_ENABLED as this run sees it, recorded once per change
  // (GLOBAL). Games while it was off are never charged, and no month that
  // started while it was off is ever opened. Never blocks the run.
  await recordBillingFlagState(isBillingEnabled(), now).catch((err) => console.error("[billing-cron] could not record the flag state:", err));
  let voids: BillingCronReport["voids"];
  try {
    voids = await sweepUnwantedMonthInvoices(now);
  } catch (err) {
    voids = { error: err instanceof Error ? err.message : String(err) };
    console.error("[billing-cron] void sweep failed:", err);
  }
  const daytime = isBillingDmHour(now);
  if (!isBillingEnabled()) return { enabled: false, daytime, voids, clubs: [] };
  // Review L2: both retry sources explicitly on would try a card twice as
  // often. Once on /admin/health (deduped), never blocks the run.
  if (bothRetrySourcesOn()) {
    await recordOpsEvent({
      orgId: null,
      kind: BILLING_ALERT_KIND,
      severity: "warning",
      title: "Club fee retries are switched on twice",
      detail:
        "BILLING_STRIPE_RETRIES and BILLING_CRON_RETRIES are both on, so a failed card is tried by Stripe AND by the hourly cron. Keep one: normally unset BILLING_CRON_RETRIES (runbook 16.1 step 6).",
      dedupeKey: "billing-retries-both-on",
      now,
    }).catch(() => undefined);
  }

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
      // The current month, at any hour (the first one starts when the free
      // month ends, often in the night).
      const opened = await openDueMonths(row.orgId, now);
      if (opened.opened.length > 0) report.opened = opened.opened;
      if (daytime) {
        // Close BEFORE the DMs: a Stop paying that takes effect at this
        // close pauses the club, and its "paused" DM goes in the same run.
        const close = await closeNextDueMonth(row.orgId, now);
        report.closed =
          "outcome" in close ? `${close.index}:${close.outcome}${close.stopped ? ":stopped" : ""}` : "error" in close ? `error:${close.error}` : close.skipped;
        const retries = await retryFailedMonthInvoices(row.orgId, now);
        if (retries.length > 0) report.retries = retries.map((r) => `${r.index}:d${r.day}:${r.outcome}`);
        for (const r of retries.filter((x) => x.outcome === "paid")) {
          await syncPaidMonthInvoice({ orgId: row.orgId, monthId: r.monthId, invoiceId: r.invoiceId, now });
        }
        report.dms = await sendScheduledBillingDms(row.orgId, now);
        report.feeTip = await sendClubFeeTip(row.orgId, now);
        report.pendingSent = (await flushPendingBillingDms(row.orgId, now)) + (await flushPendingBillingNotices(row.orgId, now));
        const monthDms = await sendMonthDms(row.orgId, now);
        if (monthDms.length > 0) report.monthDms = monthDms;
      }
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
      console.error(`[billing-cron] ${row.orgId} failed:`, err);
    }
  }
  console.log(`[billing-cron] ${now.toISOString()}: ${clubs.length} billed club(s), daytime ${daytime}`);
  return { enabled: true, daytime, voids, clubs };
}
