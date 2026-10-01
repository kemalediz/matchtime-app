/**
 * CLUB FEE BILLING, slice B3: the card actions, the billing webhook's
 * handling and plan changes on live subscriptions.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2, 4.5, 5.2 to 5.4.
 *
 * ── Where it sits ────────────────────────────────────────────────────
 *   stripe-billing.ts   the Stripe calls (real or fake), no database
 *   this file           which call, for which club, and what to store
 *   club-billing.ts     the ONE writer of the billing state
 *                       (`setBillingState`) and the one queuer of billing
 *                       DMs (`queueBillingDm`)
 *
 * This file never writes the billing state itself: every move goes through
 * `setBillingState` with an event, decided by the pure `nextBillingState`.
 * It writes only the Stripe mirror fields of `ClubBilling`.
 *
 * ── The four actions (4.5) ───────────────────────────────────────────
 * Each takes the role `requireClubBillingAccess` gave the caller and
 * refuses any role it does not serve. The server actions
 * (src/app/actions/club-billing.ts) re-check the guard on every call.
 *
 * ── The webhook (5.3) ────────────────────────────────────────────────
 * `processBillingWebhook` records the event in `BillingEvent` (its Stripe
 * id is the key, so a re-delivery is answered without handling it twice),
 * then `handleBillingEvent`. Every subscription change is synced from a
 * FRESH read of the subscription, never from the event's copy, so events
 * that arrive out of order converge on Stripe's latest truth.
 *
 * DMs (card added, card replaced, resumed, billed again) are queued only
 * while BILLING_ENABLED is on: their link opens a page that is a 404 with
 * the flag off. "Resumed" and "billed again" are written as PENDING
 * notices by the state change's own transaction and sent by
 * `flushPendingBillingNotices`, so a failed send is retried, never lost.
 * The day 21, 28, 30 and 37 reminders, the payment-failed DM and the
 * payer-changed DM are slice B4.
 *
 * ── Money safety (PR #181 review) ────────────────────────────────────
 *   - a club on Free, exempt or gone never keeps a live subscription: the
 *     webhook cancels it at once and refunds what it took;
 *   - a second live subscription is cancelled and refunded the same way,
 *     and both are recorded on /admin/health (never a DM);
 *   - before any new session, Stripe itself is asked whether the Customer
 *     has a live subscription, and open sessions are expired on every
 *     session, plan or price change;
 *   - a subscription is adopted with a compare-and-set;
 *   - a club whose subscription is unpaid always has a way to pay (setup
 *     mode, then the open invoice is retried on the new card).
 */
import type Stripe from "stripe";
import { db } from "./db";
import { buildAdminLink } from "./admin-link";
import { appBaseUrl } from "./app-url";
import {
  BILLING_LINK_TTL,
  GRACE_DAYS,
  checkoutTrialEnd,
  isBillingEnabled,
  isLiveSubscriptionStatus,
  isUnpaidSubscriptionStatus,
  planPricePence,
  subscriptionStateEvent,
  vatCountryNeedsCheck,
  type BillingAccessRole,
} from "./club-billing-rules";
import {
  loadBillingContactUserId,
  loadExemptSince,
  loadPendingBillingNotices,
  queueBillingDm,
  setBillingState,
  skipBillingNotice,
} from "./club-billing";
import { cardAddedText, cardReplacedText, moneyLabel, planBilledText, resumedText } from "./club-billing-view";
import { BILLING_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import {
  billingStripeConfig,
  buildSetupCheckoutParams,
  buildSubscriptionCheckoutParams,
  getBillingStripe,
  isClubFeeMetadata,
  type BillingStripe,
  type BillingSubscription,
  type CardDetails,
} from "./stripe-billing";

export type BillingActionRefusal =
  | "not-allowed"
  | "not-set-up"
  | "not-billable"
  /** Slice B5: paused because MatchTime was removed from the group. The way
   *  back is adding MatchTime to the group again, never a card first. */
  | "removed-from-group"
  | "already-subscribed"
  | "no-subscription"
  | "no-customer"
  | "own-card"
  | "no-card"
  | "not-found";

export type BillingActionResult = { ok: true; url: string } | { ok: false; reason: BillingActionRefusal };

interface ActionArgs {
  orgId: string;
  userId: string;
  role: BillingAccessRole;
  now?: Date;
}

const billingUrl = (orgId: string) => `${appBaseUrl()}/billing/${encodeURIComponent(orgId)}`;

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

/** The Stripe price for a plan, or null (Free, or not set up). */
async function priceIdFor(stripe: BillingStripe, plan: string, pricePence: number | null): Promise<string | null> {
  const cfg = billingStripeConfig();
  if (plan === "standard") return cfg.priceId;
  if (plan === "custom" && pricePence !== null && cfg.productId) {
    return stripe.findOrCreateCustomPrice({ productId: cfg.productId, pence: pricePence });
  }
  return null;
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

// ── Shared ──────────────────────────────────────────────────────────────

type BillingRow = NonNullable<Awaited<ReturnType<typeof loadBilling>>>;

/**
 * A setup-mode session on the club's Customer for `userId`: "Use my card
 * instead", and "update card and pay" for an unpaid subscription.
 *
 * The shared Customer is NOT reset here (round-2 review N3): the current
 * payer's card is still paying, and an abandoned session must not leave
 * their invoices with no email or address. The reset happens in the
 * webhook once the new card is confirmed (`onReplaceCard`).
 */
async function setupSession(
  stripe: BillingStripe,
  args: { orgId: string; userId: string; orgName: string; customerId: string; billing: BillingRow },
): Promise<BillingActionResult> {
  await stripe.expireOpenCheckoutSessions(args.customerId);
  const session = await stripe.createCheckoutSession(
    buildSetupCheckoutParams({ orgId: args.orgId, payerUserId: args.userId, customerId: args.customerId, baseUrl: appBaseUrl() }),
  );
  console.log(`[club-billing-stripe] ${args.orgId}: setup session ${session.id} for ${args.userId}`);
  return { ok: true, url: session.url };
}

// ── Add a card ──────────────────────────────────────────────────────────

/**
 * Add a card (5.2), for the billing contact: a Checkout session in
 * subscription mode on the club's one Customer. While the free month is
 * still running the trial ends at `max(trialEndsAt, now + 49h)` (also
 * after a cancel inside the free month); otherwise the first payment is
 * taken at once.
 *
 * Never a second subscription: Stripe itself is asked first. A live,
 * UNPAID subscription (ours or one the mirror has not seen yet) turns this
 * into "update card and pay" (setup mode) instead of a dead end; any other
 * live one refuses ("already-subscribed").
 */
export async function startClubCheckout(args: ActionArgs): Promise<BillingActionResult> {
  const now = args.now ?? new Date();
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  const org = await loadOrg(args.orgId);
  const billing = await loadBilling(args.orgId);
  if (!org || !billing) return { ok: false, reason: "not-found" };
  const status = org.billingStatus;
  if (org.billingPlan === "free") return { ok: false, reason: "not-billable" };
  if (status !== "trial" && status !== "grace" && status !== "paused" && status !== "past_due") return { ok: false, reason: "not-billable" };
  // Slice B5: it would pay for a group MatchTime is not in, and the webhook
  // deliberately never resumes a removed club. Adding MatchTime back moves
  // the club on (club-billing-removal.ts), after which a card works.
  if (status === "paused" && billing.pausedReason === "removed") return { ok: false, reason: "removed-from-group" };

  const stripe = getBillingStripe();
  const cfg = billingStripeConfig();
  if (!stripe || cfg.missingForCheckout.length > 0) {
    console.warn(`[club-billing-stripe] Add a card for ${args.orgId}: not set up (${cfg.missingForCheckout.join(", ") || "no Stripe key"})`);
    return { ok: false, reason: "not-set-up" };
  }
  if (billing.stripeCustomerId && billing.stripeSubscriptionId && isUnpaidSubscriptionStatus(billing.stripeSubscriptionStatus)) {
    return setupSession(stripe, { orgId: args.orgId, userId: args.userId, orgName: org.name, customerId: billing.stripeCustomerId, billing });
  }
  if (isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) return { ok: false, reason: "already-subscribed" };
  if (status === "past_due") return { ok: false, reason: "not-billable" };

  const priceId = await priceIdFor(stripe, org.billingPlan, org.billingPricePence);
  if (!priceId) return { ok: false, reason: "not-set-up" };
  const customerId = await ensureCustomer(stripe, args.orgId, org.name);

  // Stripe's own truth, not our mirror (a webhook may still be on its way).
  const live = await stripe.listLiveSubscriptions(customerId);
  if (live.some((s) => isUnpaidSubscriptionStatus(s.status))) {
    return setupSession(stripe, { orgId: args.orgId, userId: args.userId, orgName: org.name, customerId, billing });
  }
  if (live.length > 0) return { ok: false, reason: "already-subscribed" };

  if (billing.cardHolderUserId !== args.userId) await stripe.resetCustomerDetails({ customerId, name: org.name });
  // Only one Add a card session may be open per club: two tabs (or a
  // double tap) can never both turn into a subscription.
  await stripe.expireOpenCheckoutSessions(customerId);
  const inFreeMonth = status === "trial" || now < billing.trialEndsAt;
  const session = await stripe.createCheckoutSession(
    buildSubscriptionCheckoutParams({
      orgId: args.orgId,
      payerUserId: args.userId,
      customerId,
      priceId,
      taxRateId: cfg.taxRateId!,
      trialEnd: inFreeMonth ? checkoutTrialEnd(billing.trialEndsAt, now) : null,
      baseUrl: appBaseUrl(),
    }),
  );
  console.log(`[club-billing-stripe] ${args.orgId}: Add a card session ${session.id} for ${args.userId} (${status})`);
  return { ok: true, url: session.url };
}

// ── Use my card instead / update card and pay ───────────────────────────

/**
 * Setup mode on the club's Customer (4.5 point 4), for the billing contact
 * while the club has a live subscription: "Use my card instead" (somebody
 * else's card is paying, or none is on file) and "update card and pay"
 * (the subscription is unpaid: the webhook retries the open invoice on the
 * new card). The webhook makes the new card the default and removes the
 * old one.
 */
export async function startCardReplace(args: ActionArgs): Promise<BillingActionResult> {
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  const org = await loadOrg(args.orgId);
  const billing = await loadBilling(args.orgId);
  if (!org || !billing) return { ok: false, reason: "not-found" };
  if (!billing.stripeSubscriptionId || !isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) {
    return { ok: false, reason: "no-subscription" };
  }
  if (!billing.stripeCustomerId) return { ok: false, reason: "no-customer" };
  const stripe = getBillingStripe();
  if (!stripe) return { ok: false, reason: "not-set-up" };
  return setupSession(stripe, { orgId: args.orgId, userId: args.userId, orgName: org.name, customerId: billing.stripeCustomerId, billing });
}

// ── Change card or cancel ───────────────────────────────────────────────

/**
 * Change card or cancel (5.2): the Stripe Customer Portal, ONLY for the
 * contact whose own card is on file, and ONLY with the dedicated Portal
 * configuration (STRIPE_CLUB_PORTAL_CONFIG_ID, invoice history off): never
 * the account default, which could show an earlier payer's invoices and
 * address. A contact with no card of their own uses setup mode instead.
 */
export async function openClubPortal(args: ActionArgs): Promise<BillingActionResult> {
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  const billing = await loadBilling(args.orgId);
  if (!billing) return { ok: false, reason: "not-found" };
  if (!billing.stripeCustomerId) return { ok: false, reason: "no-customer" };
  const configuration = billingStripeConfig().portalConfigId;
  if (!configuration) return { ok: false, reason: "not-set-up" };
  if (billing.cardHolderUserId !== args.userId) return { ok: false, reason: "not-allowed" };
  const stripe = getBillingStripe();
  if (!stripe) return { ok: false, reason: "not-set-up" };
  const portal = await stripe.createPortalSession({ customerId: billing.stripeCustomerId, returnUrl: billingUrl(args.orgId), configuration });
  return { ok: true, url: portal.url };
}

/** Is the Customer Portal offered at all (the dedicated configuration set)? */
export function isClubPortalAvailable(): boolean {
  return billingStripeConfig().portalConfigId !== null;
}

// ── Remove my card ──────────────────────────────────────────────────────

/**
 * Remove my card (4.5 point 6), for an old card holder who is no longer
 * the contact: their card is detached at once, so it is never charged
 * again. The club keeps its subscription; if the next invoice finds no
 * card, the normal payment-failed path runs.
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

// ── Plan changes, suspend ───────────────────────────────────────────────

export type PlanSyncResult =
  | { action: "no-subscription" }
  | { action: "not-set-up" }
  | { action: "unchanged" }
  | { action: "cancelled" }
  | { action: "price-changed"; priceId: string };

/** Store a subscription we cancelled as cancelled at once, so Add a card
 *  is not refused while the deletion webhook is still on its way. */
async function markCancelled(orgId: string, subscriptionId: string) {
  await db.clubBilling.updateMany({ where: { orgId, stripeSubscriptionId: subscriptionId }, data: { stripeSubscriptionStatus: "canceled" } });
}

/**
 * After the platform owner's plan change has committed (`setClubPlan`):
 *   - every open Checkout session on the club's Customer is expired first,
 *     so a session started before the change can never complete on the old
 *     plan or price (the webhook would cancel it anyway, see
 *     `syncSubscription`);
 *   - Free: the live subscription is cancelled at once, no proration;
 *   - Standard or Custom: the item's price is swapped with no proration,
 *     from the next month.
 * Running it again is harmless.
 */
export async function syncPlanToStripe(orgId: string): Promise<PlanSyncResult> {
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  const stripe = getBillingStripe();
  if (stripe && billing?.stripeCustomerId) await stripe.expireOpenCheckoutSessions(billing.stripeCustomerId);
  if (!org || !billing?.stripeSubscriptionId || !isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) {
    return { action: "no-subscription" };
  }
  if (!stripe) return { action: "not-set-up" };
  if (org.billingPlan === "free") {
    await stripe.cancelSubscription(billing.stripeSubscriptionId);
    await markCancelled(orgId, billing.stripeSubscriptionId);
    console.log(`[club-billing-stripe] ${orgId}: plan Free, subscription ${billing.stripeSubscriptionId} cancelled`);
    return { action: "cancelled" };
  }
  const priceId = await priceIdFor(stripe, org.billingPlan, org.billingPricePence);
  if (!priceId) return { action: "not-set-up" };
  if (billing.stripePriceId === priceId) return { action: "unchanged" };
  const sub = await stripe.retrieveSubscription(billing.stripeSubscriptionId);
  if (!sub.itemId) throw new Error(`[club-billing-stripe] ${orgId}: subscription ${sub.id} has no item`);
  await stripe.updateSubscriptionPrice({ subscriptionId: sub.id, itemId: sub.itemId, priceId });
  await db.clubBilling.updateMany({ where: { orgId }, data: { stripePriceId: priceId } });
  console.log(`[club-billing-stripe] ${orgId}: price ${billing.stripePriceId} -> ${priceId} from the next month`);
  return { action: "price-changed", priceId };
}

/**
 * The platform owner suspended the club (plan 4.2, decision 7): its live
 * subscription is cancelled at once, no proration and NO automatic refund
 * (a refund is the owner's call, in Stripe), and open sessions expire.
 * The billing state is left as it is; the club is off by approval.
 * Called by `decideClub` after the suspension has committed.
 */
export async function cancelSubscriptionOnSuspend(orgId: string): Promise<{ action: "cancelled" | "no-subscription" | "not-set-up" }> {
  const billing = await loadBilling(orgId);
  if (!billing) return { action: "no-subscription" };
  const stripe = getBillingStripe();
  if (!stripe) return { action: billing.stripeSubscriptionId ? "not-set-up" : "no-subscription" };
  if (billing.stripeCustomerId) await stripe.expireOpenCheckoutSessions(billing.stripeCustomerId);
  if (!billing.stripeSubscriptionId || !isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) return { action: "no-subscription" };
  // Marked "cancelledBy: suspend" first, so the deletion webhook leaves the
  // club's billing state as it is (plan 4.2; round-2 review N4).
  await stripe.cancelSubscription(billing.stripeSubscriptionId, { reason: "suspend" });
  await markCancelled(orgId, billing.stripeSubscriptionId);
  console.log(`[club-billing-stripe] ${orgId}: suspended, subscription ${billing.stripeSubscriptionId} cancelled`);
  return { action: "cancelled" };
}

// ── DMs written as pending by a state change ────────────────────────────

/** A pending "resumed" or "plan-billed" DM older than this is never sent. */
export const PENDING_NOTICE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Send the club's PENDING billing notices ("resumed", "plan-billed"): rows
 * a state change wrote in its own transaction. Each goes once
 * (`queueBillingDm` claims it); one whose send fails stays pending for the
 * next call. Called after the webhook's sync and after a plan change.
 *
 * Re-checked against the club's state RIGHT NOW before anything goes
 * (round-2 review N5); otherwise the notice is marked skipped, never sent:
 *   expired      older than 3 days
 *   superseded   a newer pending notice of the same kind exists (plans
 *                toggled): only the newest can go
 *   no-contact   nobody to send it to
 *   not-current  plan-billed: the club is no longer in THAT grace cycle
 *                (its grace end is not the one this notice set); resumed:
 *                the club is not serving (paused, exempt, suspended)
 */
export async function flushPendingBillingNotices(orgId: string, now: Date = new Date()): Promise<number> {
  if (!isBillingEnabled()) return 0;
  const pending = await loadPendingBillingNotices(orgId);
  if (pending.length === 0) return 0;
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  const contact = await loadBillingContactUserId(orgId);
  let sent = 0;
  for (const p of pending) {
    const newer = pending.some((q) => q.kind === p.kind && q.createdAt > p.createdAt);
    const why =
      now.getTime() - p.createdAt.getTime() > PENDING_NOTICE_MAX_AGE_MS
        ? "expired"
        : newer
          ? "superseded"
          : !org || !contact
            ? "no-contact"
            : p.kind === "plan-billed"
              ? org.billingStatus === "grace" &&
                !!billing?.graceEndsAt &&
                billing.graceEndsAt.getTime() === new Date(p.cycleKey).getTime() + GRACE_DAYS * DAY_MS
                ? null
                : "not-current"
              : p.kind === "resumed"
                ? (org.billingStatus === "subscribed" || org.billingStatus === "past_due") && org.approvalStatus !== "suspended"
                  ? null
                  : "not-current"
                : "not-current";
    if (why) {
      await skipBillingNotice(orgId, p.kind, p.cycleKey, why);
      console.log(`[club-billing-stripe] ${orgId}: pending ${p.kind} DM (${p.cycleKey}) not sent: ${why}`);
      continue;
    }
    if (p.kind === "resumed") {
      const r = await queueBillingDm({ orgId, kind: "resumed", cycleKey: p.cycleKey, userId: contact!, text: () => resumedText(org!.language, { club: org!.name }) });
      if (r === "queued") sent++;
    } else {
      const graceEndsAt = billing!.graceEndsAt!;
      const link = await billingLink(contact!, orgId);
      const r = await queueBillingDm({
        orgId,
        kind: "plan-billed",
        cycleKey: p.cycleKey,
        userId: contact!,
        text: ({ name }) =>
          planBilledText(org!.language, {
            name,
            club: org!.name,
            pricePence: planPricePence(org!.billingPlan, org!.billingPricePence) ?? 0,
            graceEndsAt,
            link,
          }),
      });
      if (r === "queued") sent++;
    }
  }
  return sent;
}

function billingLink(userId: string, orgId: string): Promise<string> {
  return buildAdminLink({ userId, orgId, nextPath: `/billing/${orgId}`, ttlSeconds: BILLING_LINK_TTL });
}

// ── The webhook ─────────────────────────────────────────────────────────

export type BillingEventResult = { action: string; orgId: string | null; reason?: string };

const ignored = (reason: string, orgId: string | null = null): BillingEventResult => ({ action: "ignored", reason, orgId });

/**
 * Record, then handle, one verified billing event (5.3 steps 2 to 5).
 * A duplicate id that was already processed is answered at once. A
 * handler error is recorded on the row and answered 500, so Stripe
 * retries; the retry runs cleanly because `processedAt` is still null.
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

/** The subscription an invoice belongs to (this API version: `parent`). */
function invoiceSubscriptionId(inv: Record<string, unknown>): string | null {
  const parent = inv.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
  return idOf(parent?.subscription_details?.subscription) ?? idOf((inv as { subscription?: unknown }).subscription);
}

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
  switch (event.type) {
    case "checkout.session.completed": {
      const session = obj as unknown as Stripe.Checkout.Session;
      const md = (session.metadata ?? {}) as Record<string, string>;
      if (!isClubFeeMetadata(md)) return ignored("not-club-fee");
      if (session.mode === "subscription") return onSubscriptionCheckout(session, md.orgId, now);
      if (session.mode === "setup" && md.action === "replace-card") return onReplaceCard(session, md.orgId);
      return ignored("unhandled-session", md.orgId);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subId = idOf(obj.id);
      if (!subId) return ignored("no-subscription");
      return onSubscriptionChanged(subId, now);
    }
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const subId = invoiceSubscriptionId(obj);
      if (!subId) return ignored("no-subscription");
      return onSubscriptionChanged(subId, now);
    }
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

interface SyncOutcome {
  action: "synced" | "duplicate-cancelled" | "unwanted-cancelled" | "stale-subscription" | "customer-mismatch" | "no-billing";
  orgId: string;
  /** This sync adopted a NEW subscription for the club (a fresh Checkout). */
  adopted: boolean;
  resumed: boolean;
}

const outcome = (action: SyncOutcome["action"], orgId: string): SyncOutcome => ({ action, orgId, adopted: false, resumed: false });

/** Which of a subscription's paid invoices to refund when it is cancelled. */
type RefundPolicy = { mode: "all" } | { mode: "after"; since: Date } | { mode: "none" };

const refundIntentId = (subscriptionId: string) => `mt_refund_${subscriptionId}`;
const REFUND_INTENT_TYPE = "mt.refund-intent";

function intentType(policy: RefundPolicy): string {
  return policy.mode === "after" ? `${REFUND_INTENT_TYPE}:after:${policy.since.toISOString()}` : REFUND_INTENT_TYPE;
}
function policyOfIntent(type: string): RefundPolicy {
  const m = /^mt\.refund-intent:after:(.+)$/.exec(type);
  return m ? { mode: "after", since: new Date(m[1]) } : { mode: "all" };
}

/**
 * Cancel a subscription MatchTime must not keep, at once with no proration
 * (round-2 review N1, N2). ORDER MATTERS, so a failure at any step is
 * finished by the retry and money is never lost or refunded twice:
 *
 *   1. recorded on /admin/health FIRST (never a DM), before any money moves;
 *   2. a refund INTENT row (`BillingEvent` "mt_refund_<sub>", processedAt
 *      null) when anything is to be refunded, carrying which invoices;
 *   3. the refunds (one per invoice, idempotent);
 *   4. only then the cancel;
 *   5. the intent closed (processedAt).
 * A failure before 5 leaves the intent open; the next event for the same
 * subscription (Stripe retries this one) completes it, even once the
 * subscription is already cancelled.
 *
 * What is refunded:
 *   duplicate                 all of its own paid invoices
 *   Free / exempt club        only invoices paid AFTER the club stopped
 *                             being billed (`loadExemptSince`); its history
 *                             is never refunded
 *   suspended or deleted club nothing automatically (the owner decides,
 *                             in Stripe)
 */
async function cancelAndRefund(
  orgId: string,
  sub: BillingSubscription,
  why: "duplicate" | "unwanted",
  billing: BillingRow | null,
  policy: RefundPolicy,
): Promise<SyncOutcome> {
  const stripe = requireStripe();
  const plan =
    policy.mode === "none"
      ? "cancelled, not refunded automatically: refund it by hand in Stripe if it should be"
      : policy.mode === "all"
        ? "cancelled and its payments refunded"
        : `cancelled; payments since ${policy.since.toISOString()} refunded`;
  const title =
    why === "duplicate" ? `Second club fee subscription ${plan}` : `Club fee subscription for a club that is not billed (or is gone) ${plan}`;
  await recordOpsEvent({
    orgId,
    kind: BILLING_ALERT_KIND,
    severity: "warning",
    title,
    detail: `Subscription ${sub.id} (${sub.status}) on customer ${sub.customerId ?? "?"}${
      why === "duplicate" ? `; the club keeps ${billing?.stripeSubscriptionId}` : ""
    }.`,
    dedupeKey: `${why}:${sub.id}`,
  });
  if (policy.mode !== "none") await openRefundIntent(orgId, sub.id, policy);
  await finishCancelAndRefund(orgId, sub, policy);
  if (billing?.stripeSubscriptionId === sub.id) await markCancelled(orgId, sub.id);
  console.error(`[billing-webhook] ${orgId}: ${title} (${sub.id})`);
  return outcome(why === "duplicate" ? "duplicate-cancelled" : "unwanted-cancelled", orgId);
}

async function openRefundIntent(orgId: string, subscriptionId: string, policy: RefundPolicy): Promise<void> {
  try {
    await db.billingEvent.create({ data: { id: refundIntentId(subscriptionId), type: intentType(policy), orgId } });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err; // already open (a retry)
  }
}

/** Steps 3 to 5: refunds (if an intent is open), the cancel, the intent closed. */
async function finishCancelAndRefund(orgId: string, sub: BillingSubscription, policy: RefundPolicy): Promise<void> {
  const stripe = requireStripe();
  const intent = await db.billingEvent.findUnique({ where: { id: refundIntentId(sub.id) } });
  const refundDue = policy.mode !== "none" && !!intent && !intent.processedAt;
  if (refundDue) {
    try {
      const r = await stripe.refundPaidInvoices(sub.id, policy.mode === "after" ? { paidAfter: policy.since } : {});
      if (r.pence > 0) console.warn(`[billing-webhook] ${orgId}: refunded ${moneyLabel(r.pence)} on ${sub.id} (${r.invoiceIds.join(", ")})`);
    } catch (err) {
      await db.billingEvent
        .update({ where: { id: refundIntentId(sub.id) }, data: { error: (err as Error).message.slice(0, 2000) } })
        .catch(() => undefined);
      throw err; // nothing cancelled yet; Stripe retries the event
    }
  }
  if (isLiveSubscriptionStatus(sub.status)) await stripe.cancelSubscription(sub.id);
  if (refundDue) {
    await db.billingEvent.update({ where: { id: refundIntentId(sub.id) }, data: { processedAt: new Date(), error: null } });
  }
}

/**
 * Bring the club's `ClubBilling` in line with a FRESH read of one of its
 * subscriptions, then move the billing state through the one writer.
 *
 *   - a live subscription for a club that is on Free, exempt or gone is
 *     cancelled and refunded, never adopted;
 *   - the club's current subscription (or the first one, or a new one
 *     after the old one ended) is mirrored and drives the state; it is
 *     ADOPTED with a compare-and-set, so two racing deliveries cannot both
 *     adopt different subscriptions;
 *   - a DIFFERENT live subscription while the club already has one is a
 *     double subscription: cancelled and refunded;
 *   - an old, ended subscription changes nothing;
 *   - a live subscription on a price that is not the club's plan's is
 *     corrected (no proration);
 *   - the card holder is never read from subscription metadata: it is the
 *     person who completed the Checkout (`holderUserId`), else, when the
 *     subscription's card changed (the Portal), the billing contact.
 */
async function syncSubscription(
  orgId: string,
  sub: BillingSubscription,
  now: Date,
  opts: { billingCountry?: string | null; holderUserId?: string | null } = {},
  attempt = 0,
): Promise<SyncOutcome> {
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  const live = isLiveSubscriptionStatus(sub.status);

  // A refund this subscription still owes (an earlier run failed part
  // way): finish it first, whatever state the subscription is in now.
  const intent = await db.billingEvent.findUnique({ where: { id: refundIntentId(sub.id) } });
  if (intent && !intent.processedAt) {
    await finishCancelAndRefund(orgId, sub, policyOfIntent(intent.type));
    if (billing?.stripeSubscriptionId === sub.id) await markCancelled(orgId, sub.id);
    return outcome("unwanted-cancelled", orgId);
  }

  const suspended = org?.approvalStatus === "suspended";
  if (live && (!org || suspended || org.billingPlan === "free" || org.billingStatus === "exempt")) {
    let policy: RefundPolicy = { mode: "none" };
    if (org && !suspended) {
      const since = await loadExemptSince(orgId);
      if (since) policy = { mode: "after", since };
    }
    return cancelAndRefund(orgId, sub, "unwanted", billing, policy);
  }
  if (!org || !billing) return outcome("no-billing", orgId);
  if (billing.stripeCustomerId && sub.customerId && billing.stripeCustomerId !== sub.customerId) {
    console.error(`[billing-webhook] ${orgId}: subscription ${sub.id} is on ${sub.customerId}, not the club's ${billing.stripeCustomerId}; ignored`);
    return outcome("customer-mismatch", orgId);
  }

  const current = billing.stripeSubscriptionId;
  const adopting = current !== sub.id;
  if (current !== null && current !== sub.id) {
    if (!live) return outcome("stale-subscription", orgId);
    if (isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) return cancelAndRefund(orgId, sub, "duplicate", billing, { mode: "all" });
  }

  const billingCountry = opts.billingCountry !== undefined ? opts.billingCountry : billing.billingCountry;
  const data: Record<string, unknown> = {
    stripeSubscriptionId: sub.id,
    stripeSubscriptionStatus: sub.status,
    stripePriceId: sub.priceId,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
  if (!billing.stripeCustomerId && sub.customerId) data.stripeCustomerId = sub.customerId;
  if (opts.billingCountry !== undefined) data.billingCountry = opts.billingCountry;
  if (sub.status === "canceled" && !adopting) {
    // The subscription ended: no card pays for the club any more.
    Object.assign(data, { stripePaymentMethodId: null, cardBrand: null, cardLast4: null, cardHolderUserId: null });
  } else if (sub.card && live) {
    Object.assign(data, cardFields(sub.card, billingCountry));
    if (opts.holderUserId) data.cardHolderUserId = opts.holderUserId;
    else if (sub.card.paymentMethodId !== billing.stripePaymentMethodId) data.cardHolderUserId = await loadBillingContactUserId(orgId);
  } else if (opts.billingCountry !== undefined && billing.cardCountry !== null) {
    data.vatCountryCheck = vatCountryNeedsCheck(billingCountry, billing.cardCountry);
  }

  // ADOPT WITH A COMPARE-AND-SET on the subscription we read.
  const { count } = await db.clubBilling.updateMany({ where: { orgId, stripeSubscriptionId: current }, data });
  if (count !== 1) {
    if (attempt === 0) return syncSubscription(orgId, sub, now, opts, 1);
    throw new Error(`[billing-webhook] ${orgId}: subscription ${sub.id} lost the adoption race twice; Stripe will retry`);
  }

  // The club's current plan decides the price, whatever the session said.
  if (live && sub.itemId) {
    const stripe = getBillingStripe();
    const target = stripe ? await priceIdFor(stripe, org.billingPlan, org.billingPricePence) : null;
    if (stripe && target && target !== sub.priceId) {
      await stripe.updateSubscriptionPrice({ subscriptionId: sub.id, itemId: sub.itemId, priceId: target });
      await db.clubBilling.updateMany({ where: { orgId, stripeSubscriptionId: sub.id }, data: { stripePriceId: target } });
      console.log(`[billing-webhook] ${orgId}: subscription ${sub.id} price ${sub.priceId} corrected to the plan's ${target}`);
    }
  }

  // A subscription cancelled by a suspension, or any event for a suspended
  // club: mirrored above, but the billing state is left as it is (plan
  // 4.2; round-2 review N4). Nothing is ever scheduled for a suspended club.
  if (suspended || sub.metadata.cancelledBy === "suspend") return { action: "synced", orgId, adopted: adopting, resumed: false };

  const ev = subscriptionStateEvent(
    { status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd || billing.cancelAtPeriodEnd },
    { status: org.billingStatus, pausedReason: billing.pausedReason },
  );
  let resumed = false;
  if (ev) {
    // A resume by a recovered payment leaves a PENDING "resumed" DM in the
    // same transaction; a fresh Checkout's own "card added" DM says it.
    const noticeOnResume = !adopting && isBillingEnabled() ? ("resumed" as const) : undefined;
    const r = await setBillingState(orgId, ev, now, { noticeOnResume });
    resumed = r.ok && r.resumed;
  }
  return { action: "synced", orgId, adopted: adopting, resumed };
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

function requireStripe(): BillingStripe {
  const stripe = getBillingStripe();
  if (!stripe) throw new Error("[billing-webhook] Stripe is not set up (no STRIPE_SECRET_KEY): cannot re-fetch the subscription");
  return stripe;
}

/** The event's Customer must be the club's, when the club has one. */
async function customerMatches(orgId: string, customerId: string | null): Promise<boolean> {
  const billing = await loadBilling(orgId);
  return !billing?.stripeCustomerId || !customerId || billing.stripeCustomerId === customerId;
}

async function onSubscriptionCheckout(session: Stripe.Checkout.Session, orgId: string, now: Date): Promise<BillingEventResult> {
  const subId = idOf(session.subscription);
  if (!subId) return ignored("no-subscription", orgId);
  if (!(await customerMatches(orgId, idOf(session.customer)))) return ignored("customer-mismatch", orgId);
  const stripe = requireStripe();
  const sub = await stripe.retrieveSubscription(subId);
  if (!isClubFeeMetadata(sub.metadata) || sub.metadata.orgId !== orgId) return ignored("not-club-fee", orgId);
  const payer = (session.metadata ?? {}).payerUserId ?? null;
  const billingCountry = session.customer_details?.address?.country ?? null;
  const out = await syncSubscription(orgId, sub, now, { billingCountry, holderUserId: payer });
  if (out.action !== "synced") return { action: out.action, orgId };

  // The payer's email onto the club's Customer, so receipts reach them
  // (name and address come with Checkout's customer_update).
  const email = session.customer_details?.email ?? null;
  if (email && sub.customerId) await stripe.updateCustomer({ customerId: sub.customerId, email });

  // "Card added", once per subscription, to whoever added the card.
  if (payer && isBillingEnabled() && (sub.status === "trialing" || sub.status === "active")) {
    const org = await loadOrg(orgId);
    const after = await loadBilling(orgId);
    if (org && after) {
      const sessionAt = typeof session.created === "number" ? new Date(session.created * 1000) : now;
      // Back on after a pause, whichever event did the resume (Stripe does
      // not promise the order of invoice.paid and this one).
      const resumed = out.resumed || (!!after.resumedAt && after.resumedAt >= sessionAt);
      const firstPaymentOn = sub.status === "trialing" ? (sub.trialEnd ?? sub.currentPeriodEnd) : null;
      const link = await billingLink(payer, orgId);
      await queueBillingDm({
        orgId,
        kind: "card-added",
        cycleKey: sub.id,
        userId: payer,
        text: ({ name }) =>
          cardAddedText(org.language, {
            name,
            club: org.name,
            pricePence: planPricePence(org.billingPlan, org.billingPricePence) ?? 0,
            firstPaymentOn,
            resumed,
            link,
          }),
      });
    }
  }
  return { action: "card-added", orgId };
}

async function onReplaceCard(session: Stripe.Checkout.Session, orgId: string): Promise<BillingEventResult> {
  const payer = (session.metadata ?? {}).payerUserId;
  const setupIntentId = idOf(session.setup_intent);
  if (!payer || !setupIntentId) return ignored("incomplete-session", orgId);
  if (!(await customerMatches(orgId, idOf(session.customer)))) return ignored("customer-mismatch", orgId);
  // Read the OLD card and holder BEFORE anything changes in Stripe: the
  // subscription.updated our own call causes may be handled meanwhile.
  const billing = await loadBilling(orgId);
  const org = await loadOrg(orgId);
  if (!billing?.stripeCustomerId || !billing.stripeSubscriptionId || !org) return ignored("no-subscription", orgId);
  // An ended subscription cannot take a new default card; answering 200
  // (not an error) stops Stripe retrying for ever. The saved card stays on
  // the Customer, and a new Add a card picks it up from Checkout.
  if (!isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) return ignored("no-subscription", orgId);
  const stripe = requireStripe();
  const card = await stripe.retrieveSetupIntentCard(setupIntentId);
  if (!card) return ignored("no-card", orgId);
  const oldPm = billing.stripePaymentMethodId;
  const oldHolder = billing.cardHolderUserId;

  // A NEW payer's card is confirmed: only NOW is the shared Customer reset
  // (name back to the club; the previous payer's email, address, phone and
  // VAT numbers cleared), then the new payer's own details go on (round-2
  // review N3). Setup mode cannot collect a VAT number: a business payer
  // adds theirs in the Customer Portal ("Change card or cancel", tax IDs
  // allowed in its configuration), which only they can open from then on.
  if (oldHolder !== payer) await stripe.resetCustomerDetails({ customerId: billing.stripeCustomerId, name: org.name });

  await stripe.setDefaultPaymentMethod({
    customerId: billing.stripeCustomerId,
    subscriptionId: billing.stripeSubscriptionId,
    paymentMethodId: card.paymentMethodId,
    email: session.customer_details?.email ?? null,
    name: session.customer_details?.name ?? null,
  });
  // The new payer's billing address on the (reset) Customer, for invoices.
  const address = session.customer_details?.address;
  if (address?.country) {
    await stripe.updateCustomer({ customerId: billing.stripeCustomerId, address: address as Stripe.AddressParam });
  }
  if (org.billingStatus === "past_due" || isUnpaidSubscriptionStatus(billing.stripeSubscriptionStatus)) {
    // "Update card and pay": retry the open invoice on the new card at once.
    await stripe.payOpenInvoices(billing.stripeSubscriptionId);
  }
  const billingCountry = session.customer_details?.address?.country ?? billing.billingCountry;
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
      const newName = (await db.user.findUnique({ where: { id: payer }, select: { name: true } }))?.name ?? "";
      await queueBillingDm({
        orgId,
        kind: "card-replaced",
        cycleKey: oldPm,
        userId: oldHolder,
        text: ({ name }) => cardReplacedText(org.language, { name, newName, club: org.name }),
      });
    }
  }
  console.log(`[billing-webhook] ${orgId}: card replaced by ${payer} (${card.paymentMethodId}${oldPm ? `, ${oldPm} removed` : ""})`);
  return { action: "card-replaced", orgId };
}

async function onSubscriptionChanged(subId: string, now: Date): Promise<BillingEventResult> {
  // The event's own copy may be stale; Stripe's current one decides, its
  // metadata included (purpose "club-fee" and the orgId).
  const sub = await requireStripe().retrieveSubscription(subId);
  if (!isClubFeeMetadata(sub.metadata)) return ignored("not-club-fee");
  const orgId = sub.metadata.orgId;
  const out = await syncSubscription(orgId, sub, now);
  if (out.action !== "synced") return { action: out.action, orgId };
  // Any DM a state change left pending ("resumed"), including one a
  // previous delivery failed to send.
  await flushPendingBillingNotices(orgId);
  return { action: "synced", orgId };
}
