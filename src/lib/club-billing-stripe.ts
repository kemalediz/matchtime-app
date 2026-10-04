/**
 * CLUB FEE BILLING: the card actions, the billing webhook's handling and
 * the plan and suspension hooks (slice B3, rewritten for games played in
 * slice P2: a card on file and one invoice per month, no subscription).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 4.5, 5.
 *
 * ── Where it sits ────────────────────────────────────────────────────
 *   stripe-billing.ts        the Stripe calls (real or fake), no database
 *   club-billing-months.ts   the ONE writer of the billing months: open,
 *                            close and charge, waive, void, the webhook's
 *                            paid / failed / void
 *   this file                which call, for which club, and what to store
 *   club-billing.ts          the ONE writer of the billing state
 *                            (`setBillingState`) and the one queuer of
 *                            billing DMs (`queueBillingDm`)
 *
 * This file never writes the billing state itself: every move goes through
 * `setBillingState` with an event, decided by the pure `nextBillingState`.
 * It writes only the card mirror fields of `ClubBilling` and the Stop
 * paying flag (`cancelAtPeriodEnd`).
 *
 * ── The actions (4.5, 5.3) ───────────────────────────────────────────
 *   startClubCheckout   Add a card: Checkout in SETUP mode, nothing charged
 *   startCardReplace    Use my card instead, Change card, Update card and
 *                       pay: the same setup session; the webhook makes the
 *                       new card the default and pays what is unpaid on it
 *   removeMyCard        an old card holder stops paying
 *   stopPaying          billing ends with the current month (inside the
 *                       free month: the card is removed at once)
 *   keepPaying          undoes Stop paying, or starts again after it
 * Each takes the role `requireClubBillingAccess` gave the caller and
 * refuses any role it does not serve. The server actions
 * (src/app/actions/club-billing.ts) re-check the guard on every call.
 *
 * ── The webhook (5.4) ────────────────────────────────────────────────
 * `processBillingWebhook` records the event in `BillingEvent` (its Stripe
 * id is the key, so a re-delivery is answered without handling it twice),
 * then `handleBillingEvent`. Invoice events are applied from a FRESH read
 * of the invoice, never the event's copy, so events that arrive out of
 * order converge on Stripe's latest truth (a stale "failed" after "paid"
 * finds the invoice paid). Only objects with `purpose: "club-fee"` count.
 *
 * DMs (card added, card replaced, resumed, billed again) are queued only
 * while BILLING_ENABLED is on, and only 10:00 to 20:00 London; at night
 * they are noted as PENDING and the hourly cron's daytime run re-checks
 * they are still true before sending (`flushPendingBillingNotices`). A
 * failed payment or a bank check (3DS) is noted for club-billing-dms.ts.
 *
 * ── Money safety (B3 kept, P2) ───────────────────────────────────────
 *   - nothing here creates a charge: only the month close does
 *     (club-billing-months.ts); saving a card charges nothing;
 *   - a club on Free, exempt or gone never keeps a NEW card: it is removed
 *     at once; Free forgives (voids) every unpaid club fee invoice;
 *   - only one Checkout session is open per club (open ones are expired
 *     first), and on every plan change and suspension;
 *   - a club whose payment failed always has a way to pay (setup mode,
 *     then the unpaid invoices are paid on the new card).
 */
import type Stripe from "stripe";
import { db } from "./db";
import { buildAdminLink } from "./admin-link";
import { appBaseUrl } from "./app-url";
import {
  BILLING_LINK_TTL,
  GRACE_DAYS,
  isBillingEnabled,
  planPricePence,
  vatCountryNeedsCheck,
  type BillingAccessRole,
} from "./club-billing-rules";
import { monthBounds, monthIndexAt } from "./club-billing-cycle-rules";
import {
  loadBillingContactUserId,
  loadPendingBillingNotices,
  notePendingBillingNotice,
  queueBillingDm,
  setBillingState,
  skipBillingNotice,
} from "./club-billing";
import {
  applyMonthInvoice,
  applyStopIfDue,
  openDueMonths,
  payUnpaidMonths,
  unpaidMonthIds,
  voidUnpaidMonthInvoices,
  waiveOpenMonths,
} from "./club-billing-months";
import { recordSuspended } from "./club-billing-spells";
import { cardAddedText, cardReplacedText, keepPayingText, planBilledText, resumedText } from "./club-billing-view";
import { BILLING_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { isBillingDmHour } from "./club-billing-schedule-rules";
import { notePaymentProblem, sendMonthCharged } from "./club-billing-dms";
import {
  billingStripeConfig,
  buildCardSetupCheckoutParams,
  getBillingStripe,
  isClubFeeMetadata,
  type BillingStripe,
  type CardDetails,
} from "./stripe-billing";

export type BillingActionRefusal =
  | "not-allowed"
  | "not-set-up"
  | "not-billable"
  /** Slice B5: paused because MatchTime was removed from the group. The way
   *  back is adding MatchTime to the group again, never a card first. */
  | "removed-from-group"
  /** A card is already on file: Change card is the way. */
  | "already-card"
  /** Stop paying while a payment is overdue: pay it first. */
  | "past-due"
  /** Keep paying with nothing stopped. */
  | "not-stopping"
  | "no-customer"
  | "no-card"
  | "not-found";

export type BillingActionResult = { ok: true; url: string } | { ok: false; reason: BillingActionRefusal };

interface ActionArgs {
  orgId: string;
  userId: string;
  role: BillingAccessRole;
  now?: Date;
}

async function loadOrg(orgId: string) {
  return db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      language: true,
      billingStatus: true,
      billingPlan: true,
      billingPricePence: true,
      approvedAt: true,
      approvalStatus: true,
    },
  });
}

async function loadBilling(orgId: string) {
  return db.clubBilling.findUnique({ where: { orgId } });
}

/** Is this club billed at all (not Free, not exempt, not suspended)? */
function billable(org: { billingPlan: string; billingStatus: string; approvalStatus?: string | null }): boolean {
  return org.billingPlan !== "free" && org.billingStatus !== "exempt" && org.approvalStatus !== "suspended";
}

/**
 * The club's ONE Stripe Customer, created the first time it is needed and
 * kept for good (it stays with the club when the collector changes). Stored
 * with a compare-and-set, and the create call carries a per-club
 * idempotency key, so a double tap never makes two.
 */
async function ensureCustomer(stripe: BillingStripe, orgId: string, name: string): Promise<string> {
  const existing = await loadBilling(orgId);
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;
  const { id } = await stripe.createCustomer({ orgId, name });
  const { count } = await db.clubBilling.updateMany({ where: { orgId, stripeCustomerId: null }, data: { stripeCustomerId: id } });
  if (count === 1) return id;
  const winner = await loadBilling(orgId);
  return winner?.stripeCustomerId ?? id;
}

/**
 * A setup-mode session on the club's Customer for `userId`. Only one is
 * ever open per club: two tabs (or a double tap) cannot both save a card.
 *
 * The shared Customer is NOT reset here (B3 round-2 review N3): the
 * current payer's card may still be paying, and an abandoned session must
 * not leave their invoices with no email or address. The reset happens in
 * the webhook once the new card is confirmed (`onCardSaved`).
 */
async function setupSession(
  args: { orgId: string; userId: string; orgName: string },
  action: "add-card" | "replace-card",
): Promise<BillingActionResult> {
  const stripe = getBillingStripe();
  const cfg = billingStripeConfig();
  if (!stripe || cfg.missing.length > 0) {
    console.warn(`[club-billing-stripe] ${action} for ${args.orgId}: not set up (${cfg.missing.join(", ") || "no Stripe key"})`);
    return { ok: false, reason: "not-set-up" };
  }
  const customerId = await ensureCustomer(stripe, args.orgId, args.orgName);
  await stripe.expireOpenCheckoutSessions(customerId);
  const session = await stripe.createCheckoutSession(
    buildCardSetupCheckoutParams({ orgId: args.orgId, payerUserId: args.userId, customerId, baseUrl: appBaseUrl(), action }),
  );
  console.log(`[club-billing-stripe] ${args.orgId}: ${action} session ${session.id} for ${args.userId}`);
  return { ok: true, url: session.url };
}

/** The common refusals for a card session. */
async function cardSessionRefusal(args: ActionArgs): Promise<
  | { refusal: BillingActionRefusal }
  | { org: NonNullable<Awaited<ReturnType<typeof loadOrg>>>; billing: NonNullable<Awaited<ReturnType<typeof loadBilling>>> }
> {
  if (args.role !== "contact") return { refusal: "not-allowed" };
  const org = await loadOrg(args.orgId);
  const billing = await loadBilling(args.orgId);
  if (!org || !billing) return { refusal: "not-found" };
  if (!billable(org) || !["trial", "grace", "subscribed", "past_due", "paused"].includes(org.billingStatus)) return { refusal: "not-billable" };
  // Slice B5: it would pay for a group MatchTime is not in. Adding MatchTime
  // back moves the club on (club-billing-removal.ts), after which a card works.
  if (org.billingStatus === "paused" && billing.pausedReason === "removed") return { refusal: "removed-from-group" };
  return { org, billing };
}

// ── Add a card ──────────────────────────────────────────────────────────

/**
 * Add a card (5.3), for the billing contact when no card is on file:
 * Checkout in SETUP mode on the club's one Customer. NOTHING is charged
 * when the card is added, in the free month, in grace or after a pause;
 * the first charge is the first month's close (2A.1).
 */
export async function startClubCheckout(args: ActionArgs): Promise<BillingActionResult> {
  const r = await cardSessionRefusal(args);
  if ("refusal" in r) return { ok: false, reason: r.refusal };
  if (r.billing.stripePaymentMethodId) return { ok: false, reason: "already-card" };
  return setupSession({ orgId: args.orgId, userId: args.userId, orgName: r.org.name }, "add-card");
}

// ── Use my card instead / Change card / Update card and pay ─────────────

/**
 * Setup mode on the club's Customer (4.5 point 4), for the billing
 * contact: "Use my card instead" (somebody else's card is paying), "Change
 * card" (their own), and "Update card and pay" (a payment failed: the
 * webhook pays the unpaid invoices on the new card at once). The webhook
 * makes the new card the default and removes the old one.
 */
export async function startCardReplace(args: ActionArgs): Promise<BillingActionResult> {
  const r = await cardSessionRefusal(args);
  if ("refusal" in r) return { ok: false, reason: r.refusal };
  return setupSession({ orgId: args.orgId, userId: args.userId, orgName: r.org.name }, "replace-card");
}

// ── Remove my card ──────────────────────────────────────────────────────

/**
 * Remove my card (4.5 point 6), for an old card holder who is no longer
 * the contact: their card is detached at once, so it is never charged
 * again. If the next month finds no card it is recorded "no-card" and an
 * unpaid invoice follows the normal payment-failed path.
 */
export async function removeMyCard(args: ActionArgs): Promise<{ ok: true } | { ok: false; reason: BillingActionRefusal }> {
  if (args.role !== "card-holder") return { ok: false, reason: "not-allowed" };
  const billing = await loadBilling(args.orgId);
  if (!billing) return { ok: false, reason: "not-found" };
  if (billing.cardHolderUserId !== args.userId) return { ok: false, reason: "not-allowed" };
  if (!billing.stripePaymentMethodId) return { ok: false, reason: "no-card" };
  const stripe = getBillingStripe();
  if (!stripe) return { ok: false, reason: "not-set-up" };
  await stripe.detachPaymentMethod(billing.stripePaymentMethodId);
  await db.clubBilling.updateMany({
    where: { orgId: args.orgId, stripePaymentMethodId: billing.stripePaymentMethodId },
    data: { stripePaymentMethodId: null, cardBrand: null, cardLast4: null, cardHolderUserId: null },
  });
  console.log(`[club-billing-stripe] ${args.orgId}: ${args.userId} removed their card ${billing.stripePaymentMethodId}`);
  return { ok: true };
}

// ── Stop paying / Keep paying (4.2, 2A.6) ───────────────────────────────

/**
 * Stop paying, for the billing contact of a club with a card on file.
 *   - Inside the free month: the card is removed at once and the club is
 *     back in "trial" with the same end date (the reminders follow).
 *   - Otherwise: billing ends when the CURRENT month ends. MatchTime keeps
 *     working until then, that month is charged for its games as usual at
 *     its close, and the close then pauses the club ("cancelled"). No
 *     Stripe call; `cancelAtPeriodEnd` is our own flag.
 * Refused while a payment is overdue (pay it first).
 */
export async function stopPaying(
  args: ActionArgs,
): Promise<{ ok: true; freeMonth: boolean } | { ok: false; reason: BillingActionRefusal }> {
  const now = args.now ?? new Date();
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  // L3: with BILLING_ENABLED off no month opens, so a stop date could not
  // be recorded; refused.
  if (!isBillingEnabled()) return { ok: false, reason: "not-billable" };
  const org = await loadOrg(args.orgId);
  const billing = await loadBilling(args.orgId);
  if (!org || !billing) return { ok: false, reason: "not-found" };
  if (org.billingStatus === "past_due") return { ok: false, reason: "past-due" };
  if (!billable(org) || org.billingStatus !== "subscribed") return { ok: false, reason: "not-billable" };
  if (!billing.stripePaymentMethodId) return { ok: false, reason: "no-card" };

  if (now < billing.trialEndsAt) {
    const stripe = getBillingStripe();
    if (!stripe) return { ok: false, reason: "not-set-up" };
    await stripe.detachPaymentMethod(billing.stripePaymentMethodId);
    await db.clubBilling.updateMany({
      where: { orgId: args.orgId, stripePaymentMethodId: billing.stripePaymentMethodId },
      data: { stripePaymentMethodId: null, cardBrand: null, cardLast4: null, cardHolderUserId: null, cancelAtPeriodEnd: false },
    });
    await setBillingState(args.orgId, { type: "billing-stopped" }, now);
    console.log(`[club-billing-stripe] ${args.orgId}: Stop paying inside the free month; card removed, back to the free month`);
    return { ok: true, freeMonth: true };
  }
  // The current month must be open, so its end is the stop date.
  await openDueMonths(args.orgId, now);
  await db.clubBilling.updateMany({ where: { orgId: args.orgId }, data: { cancelAtPeriodEnd: true } });
  const after = await loadBilling(args.orgId);
  console.log(`[club-billing-stripe] ${args.orgId}: Stop paying; billing ends ${after?.currentPeriodEnd?.toISOString() ?? "with the current month"}`);
  return { ok: true, freeMonth: false };
}

/**
 * Keep paying, for the billing contact: undoes Stop paying before the
 * month ends, or starts billing again after it ("Start again", paused
 * "cancelled" with the card still on file). Nothing is charged by it.
 */
export async function keepPaying(args: ActionArgs): Promise<{ ok: true } | { ok: false; reason: BillingActionRefusal }> {
  const now = args.now ?? new Date();
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  const org = await loadOrg(args.orgId);
  const billing = await loadBilling(args.orgId);
  if (!org || !billing) return { ok: false, reason: "not-found" };
  if (!billable(org)) return { ok: false, reason: "not-billable" };
  if ((org.billingStatus === "subscribed" || org.billingStatus === "past_due") && billing.cancelAtPeriodEnd) {
    await db.clubBilling.updateMany({ where: { orgId: args.orgId }, data: { cancelAtPeriodEnd: false } });
    console.log(`[club-billing-stripe] ${args.orgId}: Keep paying; Stop paying undone`);
    // Once per stop date: pressing Stop and Keep again in the same month
    // never repeats it.
    await keepPayingDm(args.orgId, `undo:${billing.currentPeriodEnd?.toISOString() ?? "none"}`, now);
    return { ok: true };
  }
  if (org.billingStatus === "paused" && billing.pausedReason === "cancelled") {
    if (!billing.stripePaymentMethodId) return { ok: false, reason: "no-card" };
    // L2: a month still unpaid is paid first (Update card and pay).
    if ((await unpaidMonthIds(args.orgId)).length > 0) return { ok: false, reason: "past-due" };
    const moved = await setBillingState(args.orgId, { type: "card-added" }, now);
    if (!moved.ok) return { ok: false, reason: "not-billable" };
    console.log(`[club-billing-stripe] ${args.orgId}: Start again after Stop paying; billing resumes`);
    // Once per pause it ends.
    await keepPayingDm(args.orgId, `restart:${billing.pausedAt?.toISOString() ?? now.toISOString()}`, now);
    return { ok: true };
  }
  return { ok: false, reason: "not-stopping" };
}

/**
 * The Keep paying DM (slice P3) to the billing contact: noted PENDING and
 * sent at once in the daytime, else by the hourly cron's 10:00 run, which
 * re-checks it is still true (`flushPendingBillingNotices`). Once per
 * `cycleKey`. Never throws into the action: the action has already done
 * its work, and the cron sends what is left.
 */
async function keepPayingDm(orgId: string, cycleKey: string, now: Date): Promise<void> {
  if (!isBillingEnabled()) return;
  try {
    await notePendingBillingNotice(orgId, "keep-paying", cycleKey, now);
    await flushPendingBillingNotices(orgId, now);
  } catch (err) {
    console.error(`[club-billing-stripe] ${orgId}: Keep paying DM not sent yet (the cron retries):`, err);
  }
}

// ── Plan changes, suspend ───────────────────────────────────────────────

export type PlanChangeResult =
  | { action: "none" }
  | { action: "forgiven"; waived: number; voided: number; alreadyPaid: number; failed: number };

/**
 * After the platform owner's plan change has committed (`setClubPlan`):
 *   - every open Checkout session on the club's Customer is expired first,
 *     so a session started before the change never completes on its terms;
 *   - Free: the open month(s) are waived and every unpaid club fee invoice
 *     is voided (forgiven), plan 2A.6;
 *   - Standard or Custom: nothing in Stripe. The month close charges the
 *     LOWER of the price when the month opened and the price at the close.
 * Running it again is harmless.
 */
export async function onPlanChanged(orgId: string, now: Date = new Date()): Promise<PlanChangeResult> {
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  const stripe = getBillingStripe();
  if (stripe && billing?.stripeCustomerId) await stripe.expireOpenCheckoutSessions(billing.stripeCustomerId);
  if (!org || (org.billingPlan !== "free" && org.billingStatus !== "exempt")) return { action: "none" };
  const waived = await waiveOpenMonths(orgId, "free-plan", now);
  const v = await voidUnpaidMonthInvoices(orgId, now, "free-plan");
  console.log(`[club-billing-stripe] ${orgId}: plan Free; ${waived} open month(s) waived, ${v.voided} unpaid invoice(s) voided`);
  return { action: "forgiven", waived, ...v };
}

/**
 * The platform owner suspended the club (plan 4.2, decision 7 under games
 * played): the open month(s) are WAIVED (closed, no charge) and open
 * Checkout sessions expire. No later month opens while it is suspended.
 * Earlier unpaid invoices are left for the owner to void or keep in
 * Stripe. The billing state is left as it is; the club is off by approval.
 * Called by `decideClub` after the suspension has committed.
 */
export async function onClubSuspended(orgId: string, now: Date = new Date()): Promise<{ waived: number }> {
  const billing = await loadBilling(orgId);
  if (!billing) return { waived: 0 };
  // H1: the suspension's spell starts now; no month opens while it lasts,
  // and no game inside it is ever charged. Written FIRST (slice P3, P2
  // review LOW 3), before any Stripe call, so a Stripe error can never
  // leave a suspended club without its marker.
  await recordSuspended(orgId, now);
  const stripe = getBillingStripe();
  if (stripe && billing.stripeCustomerId) await stripe.expireOpenCheckoutSessions(billing.stripeCustomerId);
  const waived = await waiveOpenMonths(orgId, "suspended", now);
  if (waived > 0) console.log(`[club-billing-stripe] ${orgId}: suspended; ${waived} open month(s) waived`);
  return { waived };
}

// ── DMs written as pending by a state change ────────────────────────────

/** A pending "resumed" or "plan-billed" DM older than this is never sent. */
export const PENDING_NOTICE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the first (or next) charge is made for a club whose card was just
 * saved: the morning after the current billing month ends (month 1 while
 * still in the free month). Never "today": saving a card charges nothing.
 */
function nextChargeOn(trialEndsAt: Date, now: Date): Date {
  return monthBounds(trialEndsAt, Math.max(1, monthIndexAt(trialEndsAt, now))).endsAt;
}

/** Has any month of the club been charged (an invoice made)? The card
 *  added DM then says "The next charge", else "The first charge". */
async function hasChargedMonth(orgId: string): Promise<boolean> {
  const m = await db.clubBillingMonth.findFirst({ where: { orgId, stripeInvoiceId: { not: null } }, select: { id: true } });
  return !!m;
}

/**
 * Send the club's PENDING billing notices ("resumed", "plan-billed",
 * "card-added", "card-replaced"): rows a state change or the webhook wrote.
 * Each goes once (`queueBillingDm` claims it); one whose send fails stays
 * pending for the next call.
 *
 * Re-checked against the club's state RIGHT NOW before anything goes;
 * otherwise the notice is marked skipped, never sent:
 *   expired      older than 3 days
 *   superseded   a newer pending notice of the same kind exists (plans
 *                toggled): only the newest can go
 *   no-contact   nobody to send it to
 *   not-current  plan-billed: the club is no longer in THAT grace cycle;
 *                resumed: the club is not serving; card-added: that card is
 *                no longer the one on file; card-replaced: the old card is
 *                back on, or no other card is on
 */
export async function flushPendingBillingNotices(orgId: string, now: Date = new Date()): Promise<number> {
  if (!isBillingEnabled()) return 0;
  // Billing DMs go out 10:00 to 20:00 London only. At night they stay
  // pending and the hourly cron's daytime run sends what is still true.
  if (!isBillingDmHour(now)) return 0;
  const pending = await loadPendingBillingNotices(orgId);
  if (pending.length === 0) return 0;
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  const contact = await loadBillingContactUserId(orgId);
  let sent = 0;
  for (const p of pending) {
    // Only one "resumed", "plan-billed" or "keep-paying" can be current;
    // every "card replaced" is about a different card, so none supersedes
    // another.
    const newer =
      (p.kind === "resumed" || p.kind === "plan-billed" || p.kind === "keep-paying") &&
      pending.some((q) => q.kind === p.kind && q.createdAt > p.createdAt);
    let why: string | null =
      now.getTime() - p.createdAt.getTime() > PENDING_NOTICE_MAX_AGE_MS ? "expired" : newer ? "superseded" : !org ? "no-contact" : null;
    let send: (() => Promise<string>) | null = null;
    if (!why && org) {
      switch (p.kind) {
        case "plan-billed": {
          const ok =
            org.billingStatus === "grace" &&
            !!billing?.graceEndsAt &&
            billing.graceEndsAt.getTime() === new Date(p.cycleKey).getTime() + GRACE_DAYS * DAY_MS;
          if (!contact) why = "no-contact";
          else if (!ok) why = "not-current";
          else {
            const graceEndsAt = billing!.graceEndsAt!;
            const link = await billingLink(contact, orgId);
            send = () =>
              queueBillingDm({
                orgId,
                kind: "plan-billed",
                cycleKey: p.cycleKey,
                userId: contact,
                text: ({ name }) =>
                  planBilledText(org.language, {
                    name,
                    club: org.name,
                    pricePence: planPricePence(org.billingPlan, org.billingPricePence) ?? 0,
                    graceEndsAt,
                    link,
                  }),
              });
          }
          break;
        }
        case "resumed": {
          const ok = (org.billingStatus === "subscribed" || org.billingStatus === "past_due") && org.approvalStatus !== "suspended";
          if (!contact) why = "no-contact";
          else if (!ok) why = "not-current";
          else send = () => queueBillingDm({ orgId, kind: "resumed", cycleKey: p.cycleKey, userId: contact, text: () => resumedText(org.language, { club: org.name }) });
          break;
        }
        case "card-added": {
          // Still the card on file (cycleKey is its payment method), still
          // a holder, and the club still billed.
          const holder = billing?.cardHolderUserId ?? null;
          const ok = !!billing && billing.stripePaymentMethodId === p.cycleKey && !!holder && billable(org);
          if (!ok) why = "not-current";
          else {
            const resumed = !!billing!.resumedAt && billing!.resumedAt.getTime() >= p.createdAt.getTime() - DAY_MS;
            const link = await billingLink(holder!, orgId);
            const firstChargeOn = nextChargeOn(billing!.trialEndsAt, now);
            const first = !(await hasChargedMonth(orgId));
            send = () =>
              queueBillingDm({
                orgId,
                kind: "card-added",
                cycleKey: p.cycleKey,
                userId: holder!,
                text: ({ name }) =>
                  cardAddedText(org.language, {
                    name,
                    club: org.name,
                    pricePence: planPricePence(org.billingPlan, org.billingPricePence) ?? 0,
                    firstChargeOn,
                    first,
                    resumed,
                    link,
                  }),
              });
          }
          break;
        }
        case "keep-paying": {
          // cycleKey "undo:<stop date>" (Stop paying undone: still billed,
          // no stop pending) or "restart:<pause>" (billing started again
          // after the stop: serving). To the billing contact.
          const restarted = p.cycleKey.startsWith("restart:");
          const ok = restarted
            ? org.billingStatus === "subscribed" && org.approvalStatus !== "suspended"
            : (org.billingStatus === "subscribed" || org.billingStatus === "past_due") && !!billing && !billing.cancelAtPeriodEnd;
          if (!contact) why = "no-contact";
          else if (!ok || !billing || !billable(org)) why = "not-current";
          else {
            const link = await billingLink(contact, orgId);
            const nextChargeOnDate = nextChargeOn(billing.trialEndsAt, now);
            send = () =>
              queueBillingDm({
                orgId,
                kind: "keep-paying",
                cycleKey: p.cycleKey,
                userId: contact,
                text: ({ name }) =>
                  keepPayingText(org.language, {
                    name,
                    club: org.name,
                    pricePence: planPricePence(org.billingPlan, org.billingPricePence) ?? 0,
                    nextChargeOn: nextChargeOnDate,
                    restarted,
                    link,
                  }),
              });
          }
          break;
        }
        case "card-replaced": {
          // cycleKey "<old card>|<its holder>": still removed, and somebody
          // else's card on file now.
          const [oldPm, oldHolder] = p.cycleKey.split("|");
          const holder = billing?.cardHolderUserId ?? null;
          const ok = !!oldPm && !!oldHolder && billing?.stripePaymentMethodId !== oldPm && !!holder && holder !== oldHolder;
          if (!ok) why = "not-current";
          else {
            const newName = (await db.user.findUnique({ where: { id: holder! }, select: { name: true } }))?.name ?? "";
            send = () =>
              queueBillingDm({
                orgId,
                kind: "card-replaced",
                cycleKey: p.cycleKey,
                userId: oldHolder,
                text: ({ name }) => cardReplacedText(org.language, { name, newName, club: org.name }),
              });
          }
          break;
        }
        default:
          why = "not-current";
      }
    }
    if (why || !send) {
      await skipBillingNotice(orgId, p.kind, p.cycleKey, why ?? "not-current");
      console.log(`[club-billing-stripe] ${orgId}: pending ${p.kind} DM (${p.cycleKey}) not sent: ${why ?? "not-current"}`);
      continue;
    }
    if ((await send()) === "queued") sent++;
  }
  return sent;
}

function billingLink(userId: string, orgId: string): Promise<string> {
  return buildAdminLink({ userId, orgId, nextPath: `/billing/${orgId}`, ttlSeconds: BILLING_LINK_TTL });
}

// ── The webhook ─────────────────────────────────────────────────────────

export type BillingEventResult = { action: string; orgId: string | null; reason?: string };

/** One row per applied card session, at the session's CREATED time (M1). */
export const CARD_SESSION_EVENT_TYPE = "mt.card-session";

const ignored = (reason: string, orgId: string | null = null): BillingEventResult => ({ action: "ignored", reason, orgId });

/**
 * Record, then handle, one verified billing event (5.4). A duplicate id
 * that was already processed is answered at once. A handler error is
 * recorded on the row and answered 500, so Stripe retries; the retry runs
 * cleanly because `processedAt` is still null.
 */
export async function processBillingWebhook(
  event: Stripe.Event,
  now: Date = new Date(),
): Promise<{ status: 200 | 500; body: Record<string, unknown> }> {
  let row = await db.billingEvent.findUnique({ where: { id: event.id } });
  if (row?.processedAt) return { status: 200, body: { received: true, duplicate: true } };
  if (!row) {
    try {
      row = await db.billingEvent.create({ data: { id: event.id, type: event.type } });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      row = await db.billingEvent.findUnique({ where: { id: event.id } });
      if (row?.processedAt) return { status: 200, body: { received: true, duplicate: true } };
    }
  }
  try {
    const result = await handleBillingEvent(event, now);
    await db.billingEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), orgId: result.orgId, error: null },
    });
    return { status: 200, body: { received: true, ...result } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing-webhook] ${event.type} ${event.id} failed:`, err);
    await db.billingEvent.update({ where: { id: event.id }, data: { error: message.slice(0, 2000) } }).catch(() => undefined);
    return { status: 500, body: { error: "handler error" } };
  }
}

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

const INVOICE_EVENTS = new Set([
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.voided",
  "invoice.marked_uncollectible",
]);

/** What one event does. Exported for the unit tests; the route goes
 *  through `processBillingWebhook`. */
export async function handleBillingEvent(event: Stripe.Event, now: Date = new Date()): Promise<BillingEventResult> {
  // A Connect (connected account) event never belongs to the club fee,
  // which lives on MatchTime's own account.
  if ((event as { account?: string | null }).account) {
    console.warn(`[billing-webhook] ${event.type} ${event.id} from connected account ${(event as { account?: string }).account}: ignored`);
    return ignored("connect-event");
  }
  const obj = event.data.object as unknown as Record<string, unknown>;
  if (INVOICE_EVENTS.has(event.type)) return onInvoiceEvent(event.type, obj, now);
  switch (event.type) {
    case "checkout.session.completed": {
      const session = obj as unknown as Stripe.Checkout.Session;
      const md = (session.metadata ?? {}) as Record<string, string>;
      if (!isClubFeeMetadata(md)) return ignored("not-club-fee");
      if (session.mode === "setup" && (md.action === "add-card" || md.action === "replace-card")) {
        return onCardSaved(session, md.orgId, md.action, now);
      }
      // A subscription-mode session can only be a B3-era test session: the
      // club fee has no subscription any more (P2).
      return ignored(session.mode === "subscription" ? "subscription-retired" : "unhandled-session", md.orgId);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      // None exist under the games-played charge (5.4): answered 200.
      return ignored("subscription-retired");
    case "payment_method.detached": {
      const pmId = idOf(obj.id);
      if (!pmId) return ignored("no-payment-method");
      const billing = await db.clubBilling.findFirst({ where: { stripePaymentMethodId: pmId } });
      if (!billing) return ignored("not-the-card-on-file");
      await db.clubBilling.updateMany({
        where: { orgId: billing.orgId, stripePaymentMethodId: pmId },
        data: { stripePaymentMethodId: null, cardBrand: null, cardLast4: null, cardHolderUserId: null },
      });
      console.log(`[billing-webhook] ${billing.orgId}: card ${pmId} detached outside MatchTime, card fields cleared`);
      return { action: "card-cleared", orgId: billing.orgId };
    }
    default:
      return ignored("unhandled-type");
  }
}

/** The month's receipt (slice P3); a failure is logged, never thrown into
 *  the webhook: the hourly cron's daytime run sends what is left. */
async function receipt(orgId: string, monthId: string, now: Date): Promise<void> {
  try {
    await sendMonthCharged(orgId, monthId, now);
  } catch (err) {
    console.error(`[billing-webhook] ${orgId}: receipt for month ${monthId} not sent yet (the cron retries):`, err);
  }
}

/**
 * Apply a month's invoice as Stripe holds it NOW (slice P3): the same path
 * as the billing webhook's invoice events, for the hourly cron after its
 * own retry took the money, so the club moves back on and the receipt goes
 * without waiting for the webhook. Idempotent with the webhook (whichever
 * comes second changes nothing).
 */
export async function syncPaidMonthInvoice(args: { orgId: string; monthId: string; invoiceId: string; now?: Date }): Promise<BillingEventResult> {
  return onInvoiceEvent(
    "invoice.paid",
    { id: args.invoiceId, metadata: { orgId: args.orgId, purpose: "club-fee", monthId: args.monthId } },
    args.now ?? new Date(),
  );
}

function requireStripe(): BillingStripe {
  const stripe = getBillingStripe();
  if (!stripe) throw new Error("[billing-webhook] Stripe is not set up (no STRIPE_SECRET_KEY): cannot re-fetch the object");
  return stripe;
}

/** The event's Customer must be the club's, when the club has one. */
async function customerMatches(orgId: string, customerId: string | null | undefined): Promise<boolean> {
  const billing = await loadBilling(orgId);
  return !billing?.stripeCustomerId || !customerId || billing.stripeCustomerId === customerId;
}

/**
 * A month's invoice changed (5.4), applied from a FRESH read of it:
 *   paid            the month is paid; a club past due (or paused for the
 *                   failed payment) with nothing else unpaid is back to
 *                   "subscribed" (resumed, with a pending "resumed" DM)
 *   open + failed   the month failed; a "subscribed" club is past due with
 *                   7 days of grace; the "payment failed" DM is noted
 *   open + 3DS      the bank check DM is noted, with the invoice's page
 *   void            the month is void (voided or uncollectible)
 * A payment on a club that is no longer billed is recorded and flagged for
 * the owner; its state never moves.
 */
async function onInvoiceEvent(type: string, obj: Record<string, unknown>, now: Date): Promise<BillingEventResult> {
  const invoiceId = idOf(obj.id);
  if (!invoiceId) return ignored("no-invoice");
  const eventMd = (obj.metadata ?? {}) as Record<string, string>;
  if (!isClubFeeMetadata(eventMd)) return ignored("not-club-fee");
  const fresh = await requireStripe().retrieveInvoice(invoiceId);
  if (!fresh) return ignored("invoice-gone", eventMd.orgId);
  const md = fresh.metadata && Object.keys(fresh.metadata).length > 0 ? fresh.metadata : eventMd;
  if (!isClubFeeMetadata(md) || md.orgId !== eventMd.orgId) return ignored("not-club-fee");
  const orgId = md.orgId;
  const monthId = md.monthId;
  if (!monthId) return ignored("no-month", orgId);
  if (!(await customerMatches(orgId, fresh.customerId))) {
    console.error(`[billing-webhook] ${orgId}: invoice ${invoiceId} is on ${fresh.customerId}, not the club's customer; ignored`);
    return ignored("customer-mismatch", orgId);
  }
  const org = await loadOrg(orgId);

  if (fresh.status === "paid") {
    const r = await applyMonthInvoice({ orgId, monthId, invoice: fresh, kind: "paid", now });
    if (r === "not-found" || r === "mismatch") return { action: `month-${r}`, orgId };
    if (!org || !billable(org)) {
      if (r === "changed") {
        await recordOpsEvent({
          orgId,
          kind: BILLING_ALERT_KIND,
          severity: "warning",
          title: "Club fee paid for a club that is not billed",
          detail: `Invoice ${invoiceId} was paid while the club is ${org ? `${org.billingPlan}, ${org.billingStatus}, ${org.approvalStatus}` : "gone"}. Refund it by hand in Stripe if it should be.`,
          dedupeKey: `paid-not-billed:${invoiceId}`,
          now,
        }).catch(() => undefined);
      }
      return { action: "month-paid", orgId };
    }
    // L2: a Stop paying waiting for this last charge takes effect now, and
    // FIRST (slice P3, P2 review LOW 4): a club that is stopping goes
    // straight to paused (cancelled), never back on (and never told
    // "MatchTime is back") on its way there.
    const stopped = await applyStopIfDue(orgId, now);
    const billing = await loadBilling(orgId);
    const fresh2 = await loadOrg(orgId);
    const owing =
      !!fresh2 && (fresh2.billingStatus === "past_due" || (fresh2.billingStatus === "paused" && billing?.pausedReason === "payment-failed"));
    if (!stopped && owing && (await unpaidMonthIds(orgId, { except: monthId })).length === 0) {
      await setBillingState(orgId, { type: "invoice-paid" }, now, { noticeOnResume: isBillingEnabled() ? "resumed" : undefined });
      await flushPendingBillingNotices(orgId, now);
    }
    // Slice P3: the receipt, now that the money is taken. Once per month
    // (claimed); at night the cron's 10:00 run sends it. Never throws.
    await receipt(orgId, monthId, now);
    return { action: "month-paid", orgId };
  }

  if (fresh.status === "void" || fresh.status === "uncollectible") {
    const r = await applyMonthInvoice({ orgId, monthId, invoice: fresh, kind: "void", now });
    if (r === "not-found" || r === "mismatch") return { action: `month-${r}`, orgId };
    // A stop waiting for this month takes effect FIRST (slice P3, P2 review
    // LOW 4), so a stopping club is never moved back on on its way to the
    // pause. Otherwise (M3): forgiven, and a club owing only this invoice is
    // no longer owing.
    const stopped = org && billable(org) ? await applyStopIfDue(orgId, now) : false;
    if (!stopped && org && billable(org) && (await unpaidMonthIds(orgId)).length === 0) {
      const moved = await setBillingState(orgId, { type: "unpaid-cleared" }, now, { noticeOnResume: isBillingEnabled() ? "resumed" : undefined });
      if (moved.ok) await flushPendingBillingNotices(orgId, now);
    }
    return { action: "month-void", orgId };
  }

  if (fresh.status === "open" && type === "invoice.payment_failed") {
    const r = await applyMonthInvoice({ orgId, monthId, invoice: fresh, kind: "failed", now });
    if (r === "not-found" || r === "mismatch") return { action: `month-${r}`, orgId };
    if (org && billable(org)) {
      await setBillingState(orgId, { type: "payment-failed" }, now);
      // Noted for the billing contact; sent in the daytime, once per
      // invoice, if still true then (club-billing-dms.ts). Never throws.
      await notePaymentProblem({ orgId, invoiceId, kind: "payment-failed", hostedUrl: fresh.hostedInvoiceUrl, now });
    }
    return { action: "month-failed", orgId };
  }

  if (fresh.status === "open" && type === "invoice.payment_action_required") {
    if (org && billable(org)) {
      await notePaymentProblem({ orgId, invoiceId, kind: "payment-action", hostedUrl: fresh.hostedInvoiceUrl, now });
    }
    return { action: "payment-action", orgId };
  }

  return ignored(`stale-${type}`, orgId);
}

function cardFields(card: CardDetails, billingCountry: string | null): Record<string, unknown> {
  return {
    stripePaymentMethodId: card.paymentMethodId,
    cardBrand: card.brand,
    cardLast4: card.last4,
    cardCountry: card.country,
    vatCountryCheck: vatCountryNeedsCheck(billingCountry, card.country),
  };
}

/**
 * A setup-mode Checkout completed (5.4): Add a card ("add-card") or Use my
 * card instead / Change card / Update card and pay ("replace-card").
 *
 *   1. A club that is not billed (Free, exempt, gone) never keeps a NEW
 *      card: it is removed again at once.
 *   2. A NEW payer's card is confirmed: only NOW is the shared Customer
 *      reset (B3 round-2 review N3), then the card becomes the Customer's
 *      default with the payer's own email, name and address.
 *   3. The card fields and holder are stored; the old card (if any) is
 *      removed and its holder told once ("card-replaced").
 *   4. Any unpaid club fee invoice is paid on the new card at once.
 *   5. The state moves through the one writer ("card-added": trial, grace,
 *      paused for no card or after Stop paying to subscribed; a club
 *      paused for a failed payment waits for that invoice to be paid; a
 *      removed club waits for MatchTime to be added back; a suspended club
 *      never moves). NOTHING IS CHARGED by saving a card.
 *   6. "card-added" DM to the payer (Add a card only), daytime or pending.
 */
async function onCardSaved(
  session: Stripe.Checkout.Session,
  orgId: string,
  action: "add-card" | "replace-card",
  now: Date,
): Promise<BillingEventResult> {
  const payer = (session.metadata ?? {}).payerUserId;
  const setupIntentId = idOf(session.setup_intent);
  if (!payer || !setupIntentId) return ignored("incomplete-session", orgId);
  if (!(await customerMatches(orgId, idOf(session.customer)))) return ignored("customer-mismatch", orgId);
  const billing = await loadBilling(orgId);
  const org = await loadOrg(orgId);
  if (!billing?.stripeCustomerId || !org) return ignored("no-billing", orgId);
  const stripe = requireStripe();
  const card = await stripe.retrieveSetupIntentCard(setupIntentId);
  if (!card) return ignored("no-card", orgId);

  if (org.billingPlan === "free" || org.billingStatus === "exempt") {
    if (card.paymentMethodId !== billing.stripePaymentMethodId) await stripe.detachPaymentMethod(card.paymentMethodId);
    console.warn(`[billing-webhook] ${orgId}: a card was saved for a club that is not billed; removed again`);
    return ignored("not-billable", orgId);
  }

  // Slice P3 (P2 review LOW 1): every card session of one club is applied
  // UNDER ONE LOCK (a transaction-scoped advisory lock per club), so two
  // sessions delivered at the same moment are applied one after the other,
  // and the second always decides on what the first left.
  return withCardSessionLock(orgId, () => applyCardSession(session, orgId, action, payer, card, now));
}

/** How long a card session may hold its club's lock (Stripe calls inside). */
const CARD_SESSION_LOCK_TIMEOUT_MS = 30_000;

async function withCardSessionLock<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`club-card-session:${orgId}`}))`;
      return fn();
    },
    { timeout: CARD_SESSION_LOCK_TIMEOUT_MS, maxWait: CARD_SESSION_LOCK_TIMEOUT_MS },
  );
}

async function applyCardSession(
  session: Stripe.Checkout.Session,
  orgId: string,
  action: "add-card" | "replace-card",
  payer: string,
  card: CardDetails,
  now: Date,
): Promise<BillingEventResult> {
  const stripe = requireStripe();
  // Read fresh, under the lock: a session applied a moment ago is seen.
  const billing = await loadBilling(orgId);
  const org = await loadOrg(orgId);
  if (!billing?.stripeCustomerId || !org) return ignored("no-billing", orgId);

  // M1 (P2 review): ORDER. Each completed session is recorded with the time
  // it was CREATED; a session older than one already applied is a late
  // retry and must never overwrite the newer card (or wipe its payer's
  // details): its own card is detached instead. Two sessions created in the
  // SAME second are ordered by their session id (slice P3, LOW 1), so the
  // same one wins whichever is delivered first.
  const sessionAt = typeof session.created === "number" ? new Date(session.created * 1000) : now;
  const markerId = `mt_card_session_${session.id}`;
  const superseded = async () =>
    db.billingEvent.findFirst({
      where: {
        orgId,
        type: CARD_SESSION_EVENT_TYPE,
        id: { not: markerId },
        OR: [{ receivedAt: { gt: sessionAt } }, { receivedAt: sessionAt, id: { gt: markerId } }],
      },
      select: { id: true },
    });
  if (!(await superseded())) {
    try {
      await db.billingEvent.create({ data: { id: markerId, type: CARD_SESSION_EVENT_TYPE, orgId, receivedAt: sessionAt, processedAt: now } });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err; // a re-delivery of this same session
    }
  }
  if (await superseded()) {
    if (card.paymentMethodId !== billing.stripePaymentMethodId) {
      try {
        await stripe.detachPaymentMethod(card.paymentMethodId);
      } catch (err) {
        console.warn(`[billing-webhook] ${orgId}: detaching superseded card ${card.paymentMethodId}:`, (err as Error).message);
      }
    }
    console.warn(`[billing-webhook] ${orgId}: card session ${session.id} is older than the card on file; its card removed, nothing else changed`);
    return ignored("superseded-session", orgId);
  }

  // Read the OLD card and holder BEFORE anything changes in Stripe.
  const oldPm = billing.stripePaymentMethodId;
  const oldHolder = billing.cardHolderUserId;
  if (oldHolder !== payer) await stripe.resetCustomerDetails({ customerId: billing.stripeCustomerId, name: org.name });
  await stripe.setDefaultPaymentMethod({
    customerId: billing.stripeCustomerId,
    paymentMethodId: card.paymentMethodId,
    email: session.customer_details?.email ?? null,
    name: session.customer_details?.name ?? null,
  });
  const address = session.customer_details?.address;
  if (address?.country) await stripe.updateCustomer({ customerId: billing.stripeCustomerId, address: address as Stripe.AddressParam });
  const billingCountry = address?.country ?? billing.billingCountry;
  await db.clubBilling.updateMany({
    where: { orgId },
    data: { ...cardFields(card, billingCountry), billingCountry, cardHolderUserId: payer },
  });

  if (oldPm && oldPm !== card.paymentMethodId) {
    try {
      await stripe.detachPaymentMethod(oldPm);
    } catch (err) {
      // Already detached (a re-delivery, or removed in the dashboard).
      console.warn(`[billing-webhook] ${orgId}: detaching the old card ${oldPm}:`, (err as Error).message);
    }
    if (oldHolder && oldHolder !== payer && isBillingEnabled()) {
      // Keyed by the old card AND its holder, so a night-time notice can be
      // sent to the right person in the morning.
      const cycleKey = `${oldPm}|${oldHolder}`;
      if (!isBillingDmHour(now)) {
        await notePendingBillingNotice(orgId, "card-replaced", cycleKey, now);
      } else {
        const newName = (await db.user.findUnique({ where: { id: payer }, select: { name: true } }))?.name ?? "";
        await queueBillingDm({
          orgId,
          kind: "card-replaced",
          cycleKey,
          userId: oldHolder,
          text: ({ name }) => cardReplacedText(org.language, { name, newName, club: org.name }),
        });
      }
    }
  }

  // "Update card and pay": what is unpaid is paid on the new card now.
  const paidNow = await payUnpaidMonths(orgId, card.paymentMethodId);

  let resumed = false;
  if (org.approvalStatus !== "suspended") {
    const unpaid = (await unpaidMonthIds(orgId)).length > 0;
    const moved = await setBillingState(orgId, { type: "card-added", unpaid }, now);
    resumed = moved.ok && moved.resumed;
  }

  if (action === "add-card" && isBillingEnabled() && org.approvalStatus !== "suspended") {
    if (!isBillingDmHour(now)) {
      await notePendingBillingNotice(orgId, "card-added", card.paymentMethodId, now);
    } else {
      const after = await loadBilling(orgId);
      const link = await billingLink(payer, orgId);
      const wasResumed = resumed || (!!after?.resumedAt && after.resumedAt >= sessionAt);
      const first = !(await hasChargedMonth(orgId));
      await queueBillingDm({
        orgId,
        kind: "card-added",
        cycleKey: card.paymentMethodId,
        userId: payer,
        text: ({ name }) =>
          cardAddedText(org.language, {
            name,
            club: org.name,
            pricePence: planPricePence(org.billingPlan, org.billingPricePence) ?? 0,
            firstChargeOn: nextChargeOn(billing.trialEndsAt, now),
            first,
            resumed: wasResumed,
            link,
          }),
      });
    }
  }
  console.log(
    `[billing-webhook] ${orgId}: card ${card.paymentMethodId} saved by ${payer} (${action})${oldPm && oldPm !== card.paymentMethodId ? `, ${oldPm} removed` : ""}${paidNow ? `, ${paidNow} unpaid invoice(s) paid` : ""}; nothing charged for saving it`,
  );
  return { action: action === "add-card" ? "card-added" : "card-replaced", orgId };
}
