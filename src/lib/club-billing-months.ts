/**
 * CLUB FEE BILLING, games played (slice P2): the billing months, and the
 * ONE writer of `ClubBillingMonth`.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A, 3.6, 5.3, 6.
 *
 *   openDueMonths          open the months that have started (the first
 *                          at `trialEndsAt`), at any hour
 *   closeMonth             close ONE month: count its games, work out the
 *                          fee and charge it (or record why not)
 *   closeNextDueMonth      the cron's step: the club's lowest month that
 *                          ended at least 6 hours ago, in the daytime only
 *   waiveOpenMonths        Free or suspended: every open month, no charge
 *   voidUnpaidMonthInvoices  Free: every unpaid club fee invoice forgiven
 *   sweepUnwantedMonthInvoices  the hourly run's safety net for the same
 *   applyMonthInvoice      the billing webhook's paid / failed / void
 *   payUnpaidMonths        a new card pays what is unpaid at once
 *   retryFailedMonthInvoices  slice P3: the cron's own retries of a failed
 *                          month's invoice, days 1, 3 and 5 (configurable)
 *
 * The hourly cron (club-billing-scheduler.ts, slice P3) calls the open,
 * close and retry steps; nothing here runs on its own. Nothing here sends a
 * DM (club-billing-dms.ts does).
 *
 * ── Money safety ─────────────────────────────────────────────────────
 *   - BILLING_ENABLED off: no month opens or closes, nothing is charged.
 *   - Never a club that is exempt, on the Free plan, suspended, not
 *     approved, or predates self-join (Sutton FC): such a month is WAIVED,
 *     and the club is re-read right before any money moves.
 *   - Closing is a COMPARE-AND-SET (open to closing), so two cron runs can
 *     never both close or both charge a month. A "closing" month whose
 *     runner died (no write for CLOSING_STALE_MS) is taken over with a
 *     second compare-and-set on its `updatedAt`.
 *   - The amount is worked out ONCE and stored before Stripe is called; a
 *     retry charges the stored amount, never a recount.
 *   - Every Stripe create carries an idempotency key per month, the
 *     invoice id is stored as soon as Stripe returns it, and a month found
 *     in "closing" with no stored id first searches Stripe by its month id,
 *     so a crash between Stripe and our database never makes a second
 *     invoice, even after the 24 hour key window.
 *   - The invoice is a draft Stripe never finalises on its own; it is
 *     finalised only once its total is EXACTLY the amount (a Tax Rate that
 *     is not inclusive, or a stray item, stops it there).
 *   - Under 30p, nothing played, nothing scheduled, no card: no invoice
 *     at all, the month recorded with its reason and NO amount.
 *   - Club fee objects only: no Connect account, no match fee, the
 *     platform account through the billing adapter.
 */
import { db } from "./db";
import { setBillingState } from "./club-billing";
import { loadClubMonthInput, type MonthLoaderClient } from "./club-billing-month-loader";
import {
  countClubMonth,
  monthBounds,
  monthCloseDue,
  monthFee,
  monthsToOpen,
  type CycleGame,
} from "./club-billing-cycle-rules";
import { isBillingEnabled, planPricePence } from "./club-billing-rules";
import { cronRetriesEnabled, cronRetryDayDue, isBillingDmHour } from "./club-billing-schedule-rules";
import { formatLondon } from "./london-time";
import { closeNotBillableSpells } from "./club-billing-spells";
import { BILLING_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { billingStripeConfig, getBillingStripe, type BillingInvoice, type BillingStripe } from "./stripe-billing";

/** A "closing" month untouched this long was left by a runner that died. */
export const CLOSING_STALE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type MonthStatus =
  | "open"
  | "closing"
  | "no-games"
  | "below-minimum"
  | "waived"
  | "no-card"
  | "invoiced"
  | "paid"
  | "failed"
  | "void";

/** Why a month was waived. */
export type WaiveReason = "free-plan" | "suspended" | "exempt-club" | "not-approved" | "gone";

// ── Reading the club ────────────────────────────────────────────────────

async function loadClub(orgId: string) {
  return db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      approvalStatus: true,
      approvedAt: true,
      billingStatus: true,
      billingPlan: true,
      billingPricePence: true,
      clubBilling: {
        select: {
          trialEndsAt: true,
          stripeCustomerId: true,
          stripePaymentMethodId: true,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: true,
          pausedReason: true,
        },
      },
    },
  });
}

type Club = NonNullable<Awaited<ReturnType<typeof loadClub>>>;

/**
 * Why this club must not be charged at all right now, or null when it may.
 * The one test every money step reads.
 */
function waiveReasonFor(club: Club | null): WaiveReason | null {
  if (!club) return "gone";
  if (club.approvedAt === null) return "exempt-club";
  if (club.approvalStatus === "suspended") return "suspended";
  if (club.billingPlan === "free" || club.billingStatus === "exempt") return "free-plan";
  if (club.approvalStatus !== "approved") return "not-approved";
  return null;
}

// ── Opening ─────────────────────────────────────────────────────────────

export interface OpenMonthsResult {
  opened: number[];
  skipped?: "off" | "not-billed";
}

/**
 * Open the club's CURRENT month if it is not open yet (plan 6; P2 review
 * H1): never an earlier one, so a month that started while the club was
 * not billable, while billing was off, or during an outage is never
 * charged. Idempotent (unique `orgId, index`). `ClubBilling.currentPeriodEnd`
 * mirrors the end of the latest month, for the pages and Stop paying.
 *
 * Skipped: flag off; a club that is not billed (exempt, Free, suspended,
 * not approved, Sutton FC); a club paused because MatchTime was removed
 * from its group or because the payer stopped paying; and, after Stop
 * paying, any month that starts at or after the stop date.
 */
export async function openDueMonths(orgId: string, now: Date = new Date()): Promise<OpenMonthsResult> {
  if (!isBillingEnabled()) return { opened: [], skipped: "off" };
  const club = await loadClub(orgId);
  if (waiveReasonFor(club) || !club?.clubBilling) return { opened: [], skipped: "not-billed" };
  const b = club.clubBilling;
  if (club.billingStatus === "paused" && (b.pausedReason === "removed" || b.pausedReason === "cancelled")) return { opened: [] };
  const price = planPricePence(club.billingPlan, club.billingPricePence);
  if (price === null) return { opened: [], skipped: "not-billed" };

  // Billable now: a not-billable spell still open (a suspension lifted by
  // hand) ends here, so no game before this moment is ever charged (H1).
  await closeNotBillableSpells(orgId, now);
  const last = await db.clubBillingMonth.findFirst({ where: { orgId }, orderBy: { index: "desc" }, select: { index: true } });
  const due = monthsToOpen(b.trialEndsAt, last?.index ?? 0, now, { stopAt: b.cancelAtPeriodEnd ? b.currentPeriodEnd : null });
  if (due.length === 0) return { opened: [] };

  const rows = due.map((index) => ({ orgId, index, ...monthBounds(b.trialEndsAt, index), priceAtStartPence: price }));
  const { count } = await db.clubBillingMonth.createMany({ data: rows, skipDuplicates: true });
  const endsAt = rows[rows.length - 1].endsAt;
  await db.clubBilling.updateMany({
    where: { orgId, OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lt: endsAt } }] },
    data: { currentPeriodEnd: endsAt },
  });
  if (count > 0) console.log(`[club-billing-months] ${orgId}: opened month(s) ${due.join(", ")} at ${moneyOf(price)} maximum`);
  return { opened: count > 0 ? due : [] };
}

// ── Closing ─────────────────────────────────────────────────────────────

export type CloseMonthResult =
  | {
      outcome: Exclude<MonthStatus, "open" | "closing" | "failed">;
      monthId: string;
      index: number;
      amountPence: number | null;
      reason?: string | null;
      /** Stop paying took effect at this close: the club is now paused. */
      stopped?: boolean;
    }
  | { skipped: "off" | "night" | "none" | "not-found" | "not-due" | "busy" | "already-closed" | "not-set-up"; monthId?: string }
  | { error: string; monthId: string };

/**
 * The cron's close step for one club (plan 6): its LOWEST month that is
 * open (or stuck closing), if that month ended at least 6 hours ago and it
 * is daytime in London. One month per club per run, so after an outage the
 * months close in order, one an hour.
 */
export async function closeNextDueMonth(orgId: string, now: Date = new Date()): Promise<CloseMonthResult> {
  if (!isBillingEnabled()) return { skipped: "off" };
  if (!isBillingDmHour(now)) return { skipped: "night" };
  const next = await db.clubBillingMonth.findFirst({
    where: { orgId, status: { in: ["open", "closing"] } },
    orderBy: { index: "asc" },
    select: { id: true, endsAt: true },
  });
  if (!next || !monthCloseDue(next.endsAt, now)) return { skipped: "none" };
  return closeMonth(next.id, now);
}

type MonthRow = NonNullable<Awaited<ReturnType<typeof db.clubBillingMonth.findUnique>>>;

/**
 * Close ONE month (plan 6, 5.3). See the file comment for the safety
 * rules. Returns what happened; a Stripe or database error leaves the month
 * "closing" and is returned as `error` (the next run after CLOSING_STALE_MS
 * picks it up again). Tested directly; the hourly cron (P3) calls it
 * through `closeNextDueMonth`.
 */
export async function closeMonth(monthId: string, now: Date = new Date()): Promise<CloseMonthResult> {
  if (!isBillingEnabled()) return { skipped: "off", monthId };
  const found = await db.clubBillingMonth.findUnique({ where: { id: monthId } });
  if (!found) return { skipped: "not-found", monthId };
  if (found.status !== "open" && found.status !== "closing") return { skipped: "already-closed", monthId };
  if (!monthCloseDue(found.endsAt, now)) return { skipped: "not-due", monthId };

  // THE CLAIM: open to closing, or a stale closing taken over.
  if (found.status === "open") {
    const { count } = await db.clubBillingMonth.updateMany({ where: { id: monthId, status: "open" }, data: { status: "closing", updatedAt: now } });
    if (count !== 1) return { skipped: "busy", monthId };
  } else {
    if (now.getTime() - found.updatedAt.getTime() < CLOSING_STALE_MS) return { skipped: "busy", monthId };
    const { count } = await db.clubBillingMonth.updateMany({
      where: { id: monthId, status: "closing", updatedAt: found.updatedAt },
      data: { updatedAt: now },
    });
    if (count !== 1) return { skipped: "busy", monthId };
    console.warn(`[club-billing-months] ${found.orgId}: month ${found.index} was left closing; taken over`);
  }

  const month = (await db.clubBillingMonth.findUnique({ where: { id: monthId } }))!;
  try {
    return await decideAndCharge(month, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[club-billing-months] ${month.orgId}: closing month ${month.index} failed (left closing, retried later):`, err);
    return { error: message, monthId };
  }
}

/** Write the month while WE hold it (still "closing"). */
async function writeClosing(month: MonthRow, now: Date, data: Record<string, unknown>): Promise<boolean> {
  const { count } = await db.clubBillingMonth.updateMany({ where: { id: month.id, status: "closing" }, data: { ...data, updatedAt: now } });
  return count === 1;
}

/** The final write: only from "closing" (the webhook may have moved it
 *  to paid first, which is then left as it is). */
async function finish(
  month: MonthRow,
  now: Date,
  status: Exclude<MonthStatus, "open" | "closing" | "failed">,
  data: Record<string, unknown> = {},
): Promise<void> {
  await writeClosing(month, now, { ...data, status, closedAt: now, ...(status === "paid" ? { paidAt: now } : {}) });
}

async function decideAndCharge(month: MonthRow, now: Date): Promise<CloseMonthResult> {
  const done = (outcome: Exclude<MonthStatus, "open" | "closing" | "failed">, amountPence: number | null, reason?: string | null): CloseMonthResult => ({
    outcome,
    monthId: month.id,
    index: month.index,
    amountPence,
    ...(reason !== undefined ? { reason } : {}),
  });

  let club = await loadClub(month.orgId);
  const waive = waiveReasonFor(club);
  if (waive) return waiveClosing(month, now, waive, done);

  // THE COUNT, once. A retry of a month that already has its numbers
  // stored charges those numbers, never a recount.
  let scheduled = month.scheduled;
  let played = month.played;
  let pricePence = month.pricePence;
  if (scheduled === null || played === null || pricePence === null) {
    const input = await loadClubMonthInput(db as unknown as MonthLoaderClient, month.orgId, { startsAt: month.startsAt, endsAt: month.endsAt });
    if (!input) return waiveClosing(month, now, "gone", done);
    const count = countClubMonth(input);
    const fee = monthFee({
      priceAtStartPence: month.priceAtStartPence,
      priceAtClosePence: planPricePence(club!.billingPlan, club!.billingPricePence),
      played: count.played,
      scheduled: count.scheduled,
    });
    scheduled = count.scheduled;
    played = count.played;
    pricePence = fee.pricePence;
    await writeClosing(month, now, { scheduled, played, pricePence, games: gamesJson(count.games) });
  }
  const fee = monthFee({ priceAtStartPence: pricePence, played, scheduled });
  let result: CloseMonthResult;

  if (fee.outcome === "no-games") {
    await finish(month, now, "no-games", { amountPence: null, reason: scheduled === 0 ? "none-scheduled" : "none-played" });
    result = done("no-games", null, scheduled === 0 ? "none-scheduled" : "none-played");
  } else if (fee.outcome === "below-minimum") {
    await finish(month, now, "below-minimum", { amountPence: null, reason: "under-30p" });
    result = done("below-minimum", null, "under-30p");
  } else {
    // DEFENCE IN DEPTH: the club again, right before any money moves.
    club = await loadClub(month.orgId);
    const late = waiveReasonFor(club);
    if (late) return waiveClosing(month, now, late, done);
    const b = club!.clubBilling;
    if (!b?.stripeCustomerId || !b.stripePaymentMethodId) {
      await finish(month, now, "no-card", { amountPence: null, reason: "no-card" });
      result = done("no-card", null, "no-card");
    } else {
      const stripe = getBillingStripe();
      const cfg = billingStripeConfig();
      if (!stripe || cfg.missing.length > 0) {
        // Back to open, numbers cleared, for the next run once it is set up.
        await db.clubBillingMonth.updateMany({
          where: { id: month.id, status: "closing", stripeInvoiceId: null },
          data: { status: "open", scheduled: null, played: null, pricePence: null, updatedAt: now },
        });
        await recordOpsEvent({
          orgId: month.orgId,
          kind: BILLING_ALERT_KIND,
          severity: "warning",
          title: "Club fee month not charged: Stripe is not set up",
          detail: `Month ${month.index} of this club is due ${moneyOf(fee.amountPence)} but ${
            stripe ? cfg.missing.join(" and ") : "STRIPE_SECRET_KEY"
          } is not set. It is tried again every hour.`,
          dedupeKey: `not-set-up:${month.id}`,
          now,
        }).catch(() => undefined);
        return { skipped: "not-set-up", monthId: month.id };
      }
      await writeClosing(month, now, { amountPence: fee.amountPence });
      result = await chargeMonth(stripe, { ...month, scheduled, played, pricePence, amountPence: fee.amountPence }, club!, fee.amountPence, now, done);
    }
  }

  // Stop paying: billing ends with the month it was pressed in. Once that
  // month's charge is KNOWN (paid, or nothing to charge), the club is paused
  // ("cancelled"); while its invoice is still pending or failed it is not
  // (L2): `applyStopIfDue` runs again when the invoice is paid or voided.
  if ("outcome" in result && (await applyStopIfDue(month.orgId, now))) result = { ...result, stopped: true };
  return result;
}

async function waiveClosing(
  month: MonthRow,
  now: Date,
  reason: WaiveReason,
  done: (o: Exclude<MonthStatus, "open" | "closing" | "failed">, a: number | null, r?: string | null) => CloseMonthResult,
): Promise<CloseMonthResult> {
  if (month.stripeInvoiceId) {
    // An invoice was already made (a crash, then the club stopped being
    // billed): forgive it rather than charge it.
    const stripe = getBillingStripe();
    const v = stripe ? await stripe.voidInvoice(month.stripeInvoiceId) : "not-found";
    if (v === "paid") {
      await finish(month, now, "paid");
      await alertPaidWhileNotBilled(month, now, reason);
      return done("paid", month.amountPence);
    }
    await finish(month, now, "void", { reason });
    return done("void", null, reason);
  }
  await finish(month, now, "waived", { amountPence: null, reason });
  console.log(`[club-billing-months] ${month.orgId}: month ${month.index} waived (${reason})`);
  return done("waived", null, reason);
}

/**
 * Charge one month (5.3): find or create its draft invoice, store the id,
 * add the one item, check the total, finalise, pay on the card on file.
 */
async function chargeMonth(
  stripe: BillingStripe,
  month: MonthRow & { amountPence: number; scheduled: number; played: number },
  club: Club,
  amountPence: number,
  now: Date,
  done: (o: Exclude<MonthStatus, "open" | "closing" | "failed">, a: number | null, r?: string | null) => CloseMonthResult,
): Promise<CloseMonthResult> {
  const cfg = billingStripeConfig();
  const b = club.clubBilling!;
  const customerId = b.stripeCustomerId!;
  // L4: only stable values in the request (no club name, which can change
  // between a crash and the retry of the same idempotency key).
  const args = { orgId: month.orgId, monthId: month.id, customerId, description: invoiceDescription(month) };

  // M4 (P2 review): VAT comes from the Tax Rate's OWN inclusive setting.
  // Checked before any invoice is made: inclusive, 20%, active.
  const rate = await stripe.retrieveTaxRate(cfg.taxRateId!);
  if (!rate || !rate.inclusive || rate.percentage !== 20 || !rate.active) {
    await critical(
      month,
      now,
      "Club fee VAT tax rate is not set up right",
      `STRIPE_CLUB_TAX_RATE_ID ${cfg.taxRateId} is ${rate ? `${rate.inclusive ? "inclusive" : "NOT inclusive"}, ${rate.percentage}%, ${rate.active ? "active" : "archived"}` : "missing"}. It must be an active 20% INCLUSIVE rate. Nothing was invoiced or charged.`,
    );
    throw new Error(`tax rate ${cfg.taxRateId} is not an active 20% inclusive rate`);
  }

  let inv: BillingInvoice | null = month.stripeInvoiceId ? await stripe.retrieveInvoice(month.stripeInvoiceId) : null;
  if (!inv) {
    const found = (await stripe.findMonthInvoices(month.id)).filter((i) => i.status !== "void");
    if (found.length > 1) {
      await critical(month, now, "More than one club fee invoice for one month", `Invoices ${found.map((i) => i.id).join(", ")} all carry month ${month.id}. Nothing more was charged; void the extra one in Stripe.`);
      throw new Error(`month ${month.id} has ${found.length} invoices in Stripe`);
    }
    inv = found[0] ?? (await stripe.createMonthInvoice(args));
  }
  if (inv.customerId && inv.customerId !== customerId) {
    await critical(month, now, "Club fee invoice on the wrong customer", `Invoice ${inv.id} is on ${inv.customerId}, the club's customer is ${customerId}. Nothing was charged.`);
    throw new Error(`invoice ${inv.id} is not on the club's customer`);
  }
  if (month.stripeInvoiceId !== inv.id) {
    if (!(await writeClosing(month, now, { stripeInvoiceId: inv.id }))) {
      // Not ours any more: the webhook moved it on meanwhile (paid or
      // failed). Report what it is now; nothing more is done here.
      const now2 = await db.clubBillingMonth.findUnique({ where: { id: month.id }, select: { status: true } });
      const st = now2?.status;
      if (st === "paid" || st === "void") return done(st, amountPence);
      return done("invoiced", amountPence);
    }
  }

  if (inv.status === "draft") {
    if (!inv.totalPence) {
      await stripe.addMonthInvoiceItem({ ...args, invoiceId: inv.id, amountPence, productId: cfg.productId!, taxRateId: cfg.taxRateId! });
      inv = (await stripe.retrieveInvoice(inv.id)) ?? inv;
    }
    // M4: the total AND what Stripe would take must both be the amount
    // (a customer credit balance or a stray item would change amount_due).
    if (inv.totalPence !== amountPence || inv.amountDuePence !== amountPence) {
      await critical(
        month,
        now,
        "Club fee invoice total or amount due is not the amount",
        `Invoice ${inv.id} totals ${inv.totalPence ?? "?"}p with ${inv.amountDuePence ?? "?"}p amount due, but the month is ${amountPence}p. It was NOT finalised and nothing was charged.`,
      );
      throw new Error(`invoice ${inv.id} total ${inv.totalPence}p / amount due ${inv.amountDuePence}p is not the month's ${amountPence}p`);
    }
    const stop = await unbillableNow(month);
    if (stop) return forgiveInvoice(stripe, month, inv.id, stop, now, done);
    inv = await stripe.finalizeInvoice(inv.id);
  }
  let declined = false;
  if (inv.status === "open") {
    // M2 (P2 review): the club again, the moment before the money moves. A
    // club set Free or suspended since the last read is never charged: its
    // invoice is voided and the month recorded void.
    const stop = await unbillableNow(month);
    if (stop) return forgiveInvoice(stripe, month, inv.id, stop, now, done);
    if (inv.amountDuePence !== amountPence) {
      await critical(month, now, "Club fee invoice amount due is not the amount", `Invoice ${inv.id} (open) has ${inv.amountDuePence ?? "?"}p due but the month is ${amountPence}p. Nothing was charged by MatchTime.`);
      throw new Error(`invoice ${inv.id} amount due ${inv.amountDuePence}p is not the month's ${amountPence}p`);
    }
    const r = await stripe.payInvoice(inv.id, { paymentMethodId: b.stripePaymentMethodId });
    inv = r.invoice;
    declined = r.declined;
    if (inv.status === "paid") {
      const after = await unbillableNow(month);
      if (after) await alertPaidWhileNotBilled(month, now, after);
    }
  }
  const status: "paid" | "void" | "invoiced" =
    inv.status === "paid" ? "paid" : inv.status === "void" || inv.status === "uncollectible" ? "void" : "invoiced";
  await finish(month, now, status, { stripeInvoiceId: inv.id });
  console.log(
    `[club-billing-months] ${month.orgId}: month ${month.index} ${month.played} of ${month.scheduled} played, ${moneyOf(amountPence)} invoice ${inv.id} ${status}${declined ? " (declined; Stripe retries)" : ""}`,
  );
  return done(status, amountPence);
}

/** Why the club must not be charged right now (re-read), or null. */
async function unbillableNow(month: { orgId: string }): Promise<WaiveReason | null> {
  if (!isBillingEnabled()) return "not-approved";
  return waiveReasonFor(await loadClub(month.orgId));
}

/** The club stopped being billable while its month was being charged:
 *  forgive the invoice (void, or delete a draft), record it, never pay. */
async function forgiveInvoice(
  stripe: BillingStripe,
  month: MonthRow,
  invoiceId: string,
  reason: WaiveReason,
  now: Date,
  done: (o: Exclude<MonthStatus, "open" | "closing" | "failed">, a: number | null, r?: string | null) => CloseMonthResult,
): Promise<CloseMonthResult> {
  const v = await stripe.voidInvoice(invoiceId);
  if (v === "paid") {
    await finish(month, now, "paid", { stripeInvoiceId: invoiceId });
    await alertPaidWhileNotBilled(month, now, reason);
    return done("paid", month.amountPence);
  }
  await finish(month, now, "void", { reason, stripeInvoiceId: invoiceId });
  await recordOpsEvent({
    orgId: month.orgId,
    kind: BILLING_ALERT_KIND,
    severity: "info",
    title: "Club fee month not charged: the club stopped being billed while it was being charged",
    detail: `Month ${month.index}'s invoice ${invoiceId} was ${v} before any payment (${reason}).`,
    dedupeKey: `forgiven-mid-charge:${month.id}`,
    now,
  }).catch(() => undefined);
  return done("void", null, reason);
}

/** "MatchTime club fee, 1 Nov 2026 to 30 Nov 2026: 4 of 5 games played".
 *  Only the month's stored, stable numbers: the request it goes in carries
 *  an idempotency key (L4). The club's name is on the Customer. */
export function invoiceDescription(m: { startsAt: Date; endsAt: Date; played: number; scheduled: number }): string {
  const from = formatLondon(m.startsAt, "d MMM yyyy");
  const to = formatLondon(new Date(m.endsAt.getTime() - DAY_MS / 2), "d MMM yyyy");
  return `MatchTime club fee, ${from} to ${to}: ${m.played} of ${m.scheduled} games played`;
}

function gamesJson(games: CycleGame[]) {
  return games.map((g) => ({
    kickoff: g.kickoff.toISOString(),
    source: g.source,
    matchIds: g.matchIds,
    played: g.played,
    outcome: g.outcome,
    ...(g.evidence ? { evidence: g.evidence } : {}),
  }));
}

function moneyOf(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

async function critical(month: { orgId: string; id: string }, now: Date, title: string, detail: string): Promise<void> {
  console.error(`[club-billing-months] ${month.orgId}: ${title}: ${detail}`);
  await recordOpsEvent({ orgId: month.orgId, kind: BILLING_ALERT_KIND, severity: "critical", title, detail, dedupeKey: `${title}:${month.id}`, now }).catch(
    () => undefined,
  );
}

async function alertPaidWhileNotBilled(month: { orgId: string; id: string; index: number }, now: Date, why: string): Promise<void> {
  await recordOpsEvent({
    orgId: month.orgId,
    kind: BILLING_ALERT_KIND,
    severity: "warning",
    title: "Club fee paid for a club that is no longer billed",
    detail: `Month ${month.index}'s invoice was already paid when the club stopped being billed (${why}). It was left as it is: refund it by hand in Stripe if it should be.`,
    dedupeKey: `paid-not-billed:${month.id}`,
    now,
  }).catch(() => undefined);
}

// ── Stop paying (4.2) ───────────────────────────────────────────────────

/**
 * Stop paying takes effect: the club pressed it, its stop date (the end of
 * the month it was pressed in, `currentPeriodEnd`) has passed, and every
 * month up to that date is settled (none open, closing, invoiced or
 * failed). Then the club moves to "paused (cancelled)". Called after a
 * month closes and after a month's invoice is paid or voided. Idempotent.
 */
export async function applyStopIfDue(orgId: string, now: Date = new Date()): Promise<boolean> {
  const b = await db.clubBilling.findUnique({ where: { orgId }, select: { cancelAtPeriodEnd: true, currentPeriodEnd: true } });
  if (!b?.cancelAtPeriodEnd || !b.currentPeriodEnd || b.currentPeriodEnd.getTime() > now.getTime()) return false;
  const pending = await db.clubBillingMonth.findFirst({
    where: { orgId, status: { in: ["open", "closing", "invoiced", "failed"] }, endsAt: { lte: b.currentPeriodEnd } },
    select: { id: true },
  });
  if (pending) return false;
  const moved = await setBillingState(orgId, { type: "billing-stopped" }, now);
  return moved.ok;
}

// ── Free, suspend, void ─────────────────────────────────────────────────

/**
 * Free or suspended (2A.6): every OPEN month of the club is waived (closed,
 * no charge). A month already being closed re-checks the club itself right
 * before any money moves. Returns how many were waived.
 */
export async function waiveOpenMonths(orgId: string, reason: "free-plan" | "suspended", now: Date = new Date()): Promise<number> {
  const { count } = await db.clubBillingMonth.updateMany({
    where: { orgId, status: "open" },
    data: { status: "waived", reason, amountPence: null, closedAt: now, updatedAt: now },
  });
  if (count > 0) console.log(`[club-billing-months] ${orgId}: ${count} open month(s) waived (${reason})`);
  return count;
}

/** Months with an invoice that may still be charged: invoiced, failed,
 *  and one stuck CLOSING whose invoice was already made (M2). */
const UNPAID_WITH_INVOICE: MonthStatus[] = ["invoiced", "failed", "closing"];

/**
 * Plan Free (2A.6): every unpaid club fee invoice of the club is forgiven
 * (voided, or a draft deleted) and its month marked void. One that turns
 * out to be paid already is marked paid and flagged for the owner (refund
 * by hand if it should be). A Stripe failure is counted and left for the
 * hourly sweep.
 */
export async function voidUnpaidMonthInvoices(
  orgId: string,
  now: Date = new Date(),
  reason: WaiveReason = "free-plan",
): Promise<{ voided: number; alreadyPaid: number; failed: number }> {
  const months = await db.clubBillingMonth.findMany({
    where: { orgId, status: { in: UNPAID_WITH_INVOICE }, stripeInvoiceId: { not: null } },
    select: { id: true, orgId: true, index: true, stripeInvoiceId: true },
  });
  const out = { voided: 0, alreadyPaid: 0, failed: 0 };
  if (months.length === 0) return out;
  const stripe = getBillingStripe();
  for (const m of months) {
    try {
      if (!stripe) throw new Error("Stripe is not set up");
      const v = await stripe.voidInvoice(m.stripeInvoiceId!);
      if (v === "paid") {
        await db.clubBillingMonth.updateMany({ where: { id: m.id, status: { in: UNPAID_WITH_INVOICE } }, data: { status: "paid", paidAt: now, updatedAt: now } });
        await alertPaidWhileNotBilled(m, now, reason);
        out.alreadyPaid++;
      } else {
        await db.clubBillingMonth.updateMany({ where: { id: m.id, status: { in: UNPAID_WITH_INVOICE } }, data: { status: "void", reason, updatedAt: now } });
        out.voided++;
      }
    } catch (err) {
      out.failed++;
      console.error(`[club-billing-months] ${orgId}: could not void month ${m.index}'s invoice ${m.stripeInvoiceId}:`, err);
      await recordOpsEvent({
        orgId,
        kind: BILLING_ALERT_KIND,
        severity: "warning",
        title: "A club fee invoice could not be voided yet",
        detail: `Invoice ${m.stripeInvoiceId} (month ${m.index}) is still unpaid on a club that is no longer billed (${reason}). The hourly billing run tries again; void it in Stripe if this persists.`,
        dedupeKey: `void-failed:${m.id}`,
        now,
      }).catch(() => undefined);
    }
  }
  return out;
}

/**
 * The hourly billing run's safety net (replacing B3's refund sweep): any
 * unpaid club fee invoice of a club that must not be charged (Free,
 * exempt, gone) is voided, WHATEVER BILLING_ENABLED says, so Stripe's own
 * retries can never take money from a club set Free. A suspended club's
 * earlier invoices are left for the owner (plan 2A.6).
 */
export async function sweepUnwantedMonthInvoices(now: Date = new Date()): Promise<{ voided: number; failed: number }> {
  const months = await db.clubBillingMonth.findMany({
    where: { status: { in: UNPAID_WITH_INVOICE }, stripeInvoiceId: { not: null } },
    select: { orgId: true },
  });
  const out = { voided: 0, failed: 0 };
  for (const orgId of [...new Set(months.map((m) => m.orgId))]) {
    const reason = waiveReasonFor(await loadClub(orgId));
    if (reason !== "free-plan" && reason !== "exempt-club" && reason !== "gone") continue;
    const r = await voidUnpaidMonthInvoices(orgId, now, reason);
    out.voided += r.voided;
    out.failed += r.failed;
  }
  return out;
}

// ── The webhook's writes (5.4) ──────────────────────────────────────────

/**
 * Put an invoice event onto its month: "paid" (from closing, invoiced or
 * failed), "failed" (from closing or invoiced: a stale failure after a
 * payment never undoes it), "void" (anything not paid). Idempotent: a
 * re-delivery finds nothing to change. An invoice that is not the month's
 * own (the month already names another) is never applied and is flagged
 * critical: it would mean two invoices for one month.
 */
export async function applyMonthInvoice(args: {
  orgId: string;
  monthId: string;
  invoice: BillingInvoice;
  kind: "paid" | "failed" | "void";
  now: Date;
}): Promise<"changed" | "unchanged" | "mismatch" | "not-found"> {
  const m = await db.clubBillingMonth.findUnique({ where: { id: args.monthId } });
  if (!m || m.orgId !== args.orgId) return "not-found";
  if (m.stripeInvoiceId && m.stripeInvoiceId !== args.invoice.id) {
    await critical(
      m,
      args.now,
      "A second club fee invoice for one month",
      `Invoice ${args.invoice.id} (${args.invoice.status}) carries month ${m.index}, whose invoice is ${m.stripeInvoiceId}. Not applied; check Stripe and refund or void the extra one.`,
    );
    return "mismatch";
  }
  const from: Record<typeof args.kind, MonthStatus[]> = {
    // "void" too (M3): Stripe can still collect an invoice it had marked
    // uncollectible. Money taken is always recorded.
    paid: ["closing", "invoiced", "failed", "void"],
    failed: ["closing", "invoiced"],
    void: ["closing", "invoiced", "failed"],
  };
  const data =
    args.kind === "paid"
      ? { status: "paid", paidAt: args.now }
      : args.kind === "failed"
        ? { status: "failed" }
        : { status: "void", reason: "voided-in-stripe" };
  const { count } = await db.clubBillingMonth.updateMany({
    where: { id: m.id, status: { in: from[args.kind] } },
    data: { ...data, stripeInvoiceId: args.invoice.id, ...(m.closedAt ? {} : { closedAt: args.now }), updatedAt: args.now },
  });
  if (count === 1 && args.kind === "paid" && m.status === "void") {
    await recordOpsEvent({
      orgId: m.orgId,
      kind: BILLING_ALERT_KIND,
      severity: "warning",
      title: "Club fee paid after it was voided or marked uncollectible",
      detail: `Invoice ${args.invoice.id} (month ${m.index}) was paid after MatchTime recorded it void. Recorded as paid; refund it by hand in Stripe if it should not have been taken.`,
      dedupeKey: `paid-after-void:${args.invoice.id}`,
      now: args.now,
    }).catch(() => undefined);
  }
  return count === 1 ? "changed" : "unchanged";
}

/** The club's months whose payment failed and is still owed. */
export async function unpaidMonthIds(orgId: string, opts: { except?: string } = {}): Promise<string[]> {
  const rows = await db.clubBillingMonth.findMany({ where: { orgId, status: "failed" }, select: { id: true } });
  return rows.map((r) => r.id).filter((id) => id !== opts.except);
}

/**
 * A new card is on ("Update card and pay", 4.5 point 4): every unpaid
 * month's open invoice is paid on it at once. A decline is Stripe's to
 * report. Returns how many were paid now.
 */
export async function payUnpaidMonths(orgId: string, paymentMethodId: string): Promise<number> {
  // The kill switch: with BILLING_ENABLED off MatchTime asks Stripe to take
  // nothing (invoices already open are left to Stripe and the owner).
  if (!isBillingEnabled()) return 0;
  // L1: never for a club that must not be charged (Free, exempt, suspended).
  if (waiveReasonFor(await loadClub(orgId))) return 0;
  const months = await db.clubBillingMonth.findMany({
    where: { orgId, status: { in: ["invoiced", "failed"] }, stripeInvoiceId: { not: null } },
    select: { id: true, index: true, stripeInvoiceId: true },
  });
  const stripe = getBillingStripe();
  if (!stripe || months.length === 0) return 0;
  let paid = 0;
  for (const m of months) {
    try {
      const inv = await stripe.retrieveInvoice(m.stripeInvoiceId!);
      if (inv?.status !== "open") continue;
      const r = await stripe.payInvoice(inv.id, { paymentMethodId });
      if (!r.declined) paid++;
    } catch (err) {
      console.warn(`[club-billing-months] ${orgId}: paying month ${m.index} on the new card failed:`, (err as Error).message);
    }
  }
  return paid;
}

// ── Slice P3: the cron's own retries of a failed month (5.3) ────────────

/** One `BillingEvent` per retry made, id "mt_invoice_retry_<month>_d<day>":
 *  the claim (two cron runs never both retry a day) and the record. */
export const INVOICE_RETRY_EVENT_TYPE = "mt.invoice-retry";

export interface MonthRetry {
  monthId: string;
  index: number;
  invoiceId: string;
  day: number;
  outcome: "paid" | "declined" | "not-open" | "mismatch" | "error";
}

/**
 * The hourly cron's retries of a FAILED month's invoice (plan 5.3), for a
 * Stripe account whose automatic retries do not cover one-off invoices:
 * `invoices.pay` on the card on file on days 1, 3 and 5 after the month's
 * first attempt (its close), in the daytime only, once per day (claimed),
 * only the latest due day after an outage. Off with BILLING_CRON_RETRIES=0.
 *
 * Never for a club that must not be charged (flag off, Free, exempt,
 * suspended, not approved), a paused club, or one with no card; never an
 * invoice that is not open or whose amount due is not the month's amount.
 * A paid retry is reported back to the caller, which applies it at once
 * (the webhook would too: whichever is second changes nothing).
 */
export async function retryFailedMonthInvoices(orgId: string, now: Date = new Date()): Promise<MonthRetry[]> {
  if (!isBillingEnabled() || !cronRetriesEnabled() || !isBillingDmHour(now)) return [];
  const club = await loadClub(orgId);
  if (waiveReasonFor(club) || !club?.clubBilling || club.billingStatus === "paused") return [];
  const paymentMethodId = club.clubBilling.stripePaymentMethodId;
  if (!paymentMethodId) return [];
  const months = await db.clubBillingMonth.findMany({
    where: { orgId, status: "failed", stripeInvoiceId: { not: null }, closedAt: { not: null } },
    select: { id: true, index: true, stripeInvoiceId: true, amountPence: true, closedAt: true },
  });
  if (months.length === 0) return [];
  const stripe = getBillingStripe();
  if (!stripe) return [];
  const out: MonthRetry[] = [];
  for (const m of months) {
    const prefix = `mt_invoice_retry_${m.id}_d`;
    const tried = await db.billingEvent.findMany({ where: { orgId, type: INVOICE_RETRY_EVENT_TYPE }, select: { id: true } });
    const done = tried.filter((e) => e.id.startsWith(prefix)).map((e) => Number(e.id.slice(prefix.length)));
    const day = cronRetryDayDue(m.closedAt!, now, done);
    if (day === null) continue;
    // THE CLAIM: one row per month and day.
    try {
      await db.billingEvent.create({ data: { id: `${prefix}${day}`, type: INVOICE_RETRY_EVENT_TYPE, orgId, receivedAt: now, processedAt: now } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue; // another run has it
      throw err;
    }
    const base = { monthId: m.id, index: m.index, invoiceId: m.stripeInvoiceId!, day };
    try {
      const inv = await stripe.retrieveInvoice(m.stripeInvoiceId!);
      if (!inv || inv.status !== "open") {
        out.push({ ...base, outcome: "not-open" });
        continue;
      }
      if (inv.amountDuePence !== m.amountPence) {
        await critical(
          { orgId, id: m.id },
          now,
          "Club fee retry refused: amount due is not the month's amount",
          `Invoice ${inv.id} (month ${m.index}) has ${inv.amountDuePence ?? "?"}p due but the month is ${m.amountPence ?? "?"}p. MatchTime did not retry it.`,
        );
        out.push({ ...base, outcome: "mismatch" });
        continue;
      }
      // The club again, the moment before the money moves.
      if (await unbillableNow({ orgId })) continue;
      const r = await stripe.payInvoice(inv.id, { paymentMethodId });
      const outcome = r.invoice.status === "paid" ? "paid" : "declined";
      console.log(`[club-billing-months] ${orgId}: month ${m.index} retry day ${day}: ${outcome}`);
      out.push({ ...base, outcome });
    } catch (err) {
      console.error(`[club-billing-months] ${orgId}: month ${m.index} retry day ${day} failed:`, err);
      out.push({ ...base, outcome: "error" });
    }
  }
  return out;
}
