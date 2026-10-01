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
 * the flag off. The day 21, 28, 30 and 37 reminders, the payment-failed
 * DM and the payer-changed DM are slice B4.
 */
import type Stripe from "stripe";
import { db } from "./db";
import { buildAdminLink } from "./admin-link";
import { appBaseUrl } from "./app-url";
import {
  BILLING_LINK_TTL,
  checkoutTrialEnd,
  isBillingEnabled,
  isLiveSubscriptionStatus,
  planPricePence,
  subscriptionStateEvent,
  vatCountryNeedsCheck,
  type BillingAccessRole,
} from "./club-billing-rules";
import { loadBillingContactUserId, queueBillingDm, setBillingState } from "./club-billing";
import { cardAddedText, cardReplacedText, planBilledText, resumedText } from "./club-billing-view";
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

// ── Add a card ──────────────────────────────────────────────────────────

/**
 * Add a card (5.2), for the billing contact when the club has no live
 * subscription: a Checkout session in subscription mode. In the free month
 * the trial ends at `max(trialEndsAt, now + 49h)`; in grace or paused the
 * first payment is taken at once.
 */
export async function startClubCheckout(args: ActionArgs): Promise<BillingActionResult> {
  const now = args.now ?? new Date();
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  const org = await loadOrg(args.orgId);
  const billing = await loadBilling(args.orgId);
  if (!org || !billing) return { ok: false, reason: "not-found" };
  const status = org.billingStatus;
  if (status !== "trial" && status !== "grace" && status !== "paused") return { ok: false, reason: "not-billable" };
  if (org.billingPlan === "free") return { ok: false, reason: "not-billable" };
  if (isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) return { ok: false, reason: "already-subscribed" };

  const stripe = getBillingStripe();
  const cfg = billingStripeConfig();
  if (!stripe || cfg.missingForCheckout.length > 0) {
    console.warn(`[club-billing-stripe] Add a card for ${args.orgId}: not set up (${cfg.missingForCheckout.join(", ") || "no Stripe key"})`);
    return { ok: false, reason: "not-set-up" };
  }
  const priceId = await priceIdFor(stripe, org.billingPlan, org.billingPricePence);
  if (!priceId) return { ok: false, reason: "not-set-up" };

  const customerId = await ensureCustomer(stripe, args.orgId, org.name);
  // Only one Add a card session may be open per club: two tabs (or a
  // double tap) can never both turn into a subscription.
  await stripe.expireOpenCheckoutSessions(customerId);
  const session = await stripe.createCheckoutSession(
    buildSubscriptionCheckoutParams({
      orgId: args.orgId,
      payerUserId: args.userId,
      customerId,
      priceId,
      taxRateId: cfg.taxRateId!,
      trialEnd: status === "trial" ? checkoutTrialEnd(billing.trialEndsAt, now) : null,
      baseUrl: appBaseUrl(),
    }),
  );
  console.log(`[club-billing-stripe] ${args.orgId}: Add a card session ${session.id} for ${args.userId} (${status})`);
  return { ok: true, url: session.url };
}

// ── Use my card instead ─────────────────────────────────────────────────

/**
 * Use my card instead (4.5 point 4), for the billing contact when the
 * club's live subscription is paid with somebody else's card: Checkout in
 * setup mode on the same Customer. The webhook makes the new card the
 * default and removes the old one.
 */
export async function startCardReplace(args: ActionArgs): Promise<BillingActionResult> {
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  const billing = await loadBilling(args.orgId);
  if (!billing) return { ok: false, reason: "not-found" };
  if (!billing.stripeSubscriptionId || !isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) {
    return { ok: false, reason: "no-subscription" };
  }
  if (billing.cardHolderUserId === args.userId) return { ok: false, reason: "own-card" };
  if (!billing.stripeCustomerId) return { ok: false, reason: "no-customer" };
  const stripe = getBillingStripe();
  if (!stripe) return { ok: false, reason: "not-set-up" };
  await stripe.expireOpenCheckoutSessions(billing.stripeCustomerId);
  const session = await stripe.createCheckoutSession(
    buildSetupCheckoutParams({ orgId: args.orgId, payerUserId: args.userId, customerId: billing.stripeCustomerId, baseUrl: appBaseUrl() }),
  );
  console.log(`[club-billing-stripe] ${args.orgId}: Use my card instead session ${session.id} for ${args.userId}`);
  return { ok: true, url: session.url };
}

// ── Change card or cancel ───────────────────────────────────────────────

/**
 * Change card or cancel (5.2): the Stripe Customer Portal, only for the
 * contact who is also the card holder (or when no card holder is
 * recorded), so a new collector never sees an earlier collector's card.
 * Invoice history is off in the Portal configuration (5.1).
 */
export async function openClubPortal(args: ActionArgs): Promise<BillingActionResult> {
  if (args.role !== "contact") return { ok: false, reason: "not-allowed" };
  const billing = await loadBilling(args.orgId);
  if (!billing) return { ok: false, reason: "not-found" };
  if (!billing.stripeCustomerId) return { ok: false, reason: "no-customer" };
  if (billing.cardHolderUserId !== null && billing.cardHolderUserId !== args.userId) return { ok: false, reason: "not-allowed" };
  const stripe = getBillingStripe();
  if (!stripe) return { ok: false, reason: "not-set-up" };
  const portal = await stripe.createPortalSession({
    customerId: billing.stripeCustomerId,
    returnUrl: billingUrl(args.orgId),
    configuration: billingStripeConfig().portalConfigId,
  });
  return { ok: true, url: portal.url };
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

// ── Plan changes on a live subscription ─────────────────────────────────

export type PlanSyncResult =
  | { action: "no-subscription" }
  | { action: "not-set-up" }
  | { action: "unchanged" }
  | { action: "cancelled" }
  | { action: "price-changed"; priceId: string };

/**
 * After the platform owner's plan change has committed (`setClubPlan`):
 *   - Free: the live subscription is cancelled at once, no proration (the
 *     club is already exempt, so the deletion webhook moves nothing);
 *   - Standard or Custom: the item's price is swapped with no proration,
 *     so the new price applies from the next month.
 * Running it again is harmless (same price: nothing sent).
 */
export async function syncPlanToStripe(orgId: string): Promise<PlanSyncResult> {
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  if (!org || !billing?.stripeSubscriptionId || !isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) {
    return { action: "no-subscription" };
  }
  const stripe = getBillingStripe();
  if (!stripe) return { action: "not-set-up" };
  if (org.billingPlan === "free") {
    await stripe.cancelSubscription(billing.stripeSubscriptionId);
    // Stored at once, so "Add a card" (after Free and back) is not refused
    // while the deletion webhook is still on its way. The webhook then
    // confirms it; the club is exempt, so it moves nothing.
    await db.clubBilling.updateMany({
      where: { orgId, stripeSubscriptionId: billing.stripeSubscriptionId },
      data: { stripeSubscriptionStatus: "canceled" },
    });
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
 * The club was billed again after Free with its free month used up
 * (`setClubPlan`'s `billedAgain: "grace"`): one DM to the billing contact
 * asking for a card before the fresh grace ends. Claimed once per grace end.
 */
export async function notifyPlanBilledAgain(orgId: string): Promise<string> {
  if (!isBillingEnabled()) return "flag-off";
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  if (!org || !billing?.graceEndsAt || org.billingStatus !== "grace") return "not-in-grace";
  const contact = await loadBillingContactUserId(orgId);
  if (!contact) {
    console.warn(`[club-billing-stripe] ${orgId}: billed again but there is no billing contact to ask for a card`);
    return "no-contact";
  }
  const link = await billingLink(contact, orgId);
  const graceEndsAt = billing.graceEndsAt;
  return queueBillingDm({
    orgId,
    kind: "plan-billed",
    cycleKey: graceEndsAt.toISOString(),
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
      return onSubscriptionChanged(subId, now, { invoiceId: idOf(obj.id), billingReason: (obj.billing_reason as string) ?? null });
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
  action: "synced" | "duplicate-cancelled" | "stale-subscription" | "customer-mismatch" | "no-billing";
  orgId: string;
  /** This sync adopted a NEW subscription for the club (a fresh Checkout). */
  adopted: boolean;
  resumed: boolean;
}

/**
 * Bring the club's `ClubBilling` in line with a FRESH read of one of its
 * subscriptions, then move the billing state through the one writer.
 *
 *   - the club's current subscription (or the first one, or a new one
 *     after the old one ended) is mirrored and drives the state;
 *   - a DIFFERENT live subscription while the club already has one is a
 *     double subscription: it is cancelled at once and never kept;
 *   - an old, ended subscription changes nothing.
 */
async function syncSubscription(
  orgId: string,
  sub: BillingSubscription,
  now: Date,
  opts: { billingCountry?: string | null } = {},
): Promise<SyncOutcome> {
  const org = await loadOrg(orgId);
  const billing = await loadBilling(orgId);
  if (!org || !billing) return { action: "no-billing", orgId, adopted: false, resumed: false };
  if (billing.stripeCustomerId && sub.customerId && billing.stripeCustomerId !== sub.customerId) {
    console.error(`[billing-webhook] ${orgId}: subscription ${sub.id} is on ${sub.customerId}, not the club's ${billing.stripeCustomerId}; ignored`);
    return { action: "customer-mismatch", orgId, adopted: false, resumed: false };
  }

  const current = billing.stripeSubscriptionId;
  let adopted = current === null;
  if (current !== null && current !== sub.id) {
    if (!isLiveSubscriptionStatus(sub.status)) return { action: "stale-subscription", orgId, adopted: false, resumed: false };
    if (isLiveSubscriptionStatus(billing.stripeSubscriptionStatus)) {
      const stripe = getBillingStripe();
      if (stripe) await stripe.cancelSubscription(sub.id);
      console.error(
        `[billing-webhook] ${orgId}: DOUBLE SUBSCRIPTION ${sub.id} beside live ${current}; ${sub.id} cancelled. Check Stripe for a payment to refund.`,
      );
      return { action: "duplicate-cancelled", orgId, adopted: false, resumed: false };
    }
    adopted = true; // the old one ended; this is the club's new subscription
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
  if (sub.card && isLiveSubscriptionStatus(sub.status)) {
    Object.assign(data, cardFields(sub.card, billingCountry));
    // Who added the card: the payer named on a subscription this sync
    // adopts (a fresh Checkout), or when no card was on file at all. A
    // replacement sets the holder itself (onReplaceCard).
    const nothingOnFile = billing.cardHolderUserId === null && billing.stripePaymentMethodId === null;
    if (sub.metadata.payerUserId && (adopted || nothingOnFile)) data.cardHolderUserId = sub.metadata.payerUserId;
  } else if (opts.billingCountry !== undefined && billing.cardCountry !== null) {
    data.vatCountryCheck = vatCountryNeedsCheck(billingCountry, billing.cardCountry);
  }
  await db.clubBilling.updateMany({ where: { orgId }, data });

  const ev = subscriptionStateEvent(
    { status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd || billing.cancelAtPeriodEnd },
    { status: org.billingStatus, pausedReason: billing.pausedReason },
  );
  let resumed = false;
  if (ev) {
    const r = await setBillingState(orgId, ev, now);
    resumed = r.ok && r.resumed;
  }
  return { action: "synced", orgId, adopted, resumed };
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
  const sub = await requireStripe().retrieveSubscription(subId);
  if (!isClubFeeMetadata(sub.metadata) || sub.metadata.orgId !== orgId) return ignored("not-club-fee", orgId);
  const billingCountry = session.customer_details?.address?.country ?? null;
  const out = await syncSubscription(orgId, sub, now, { billingCountry });
  if (out.action !== "synced") return { action: out.action, orgId };

  // "Card added", once per subscription, to whoever added the card.
  const payer = (session.metadata ?? {}).payerUserId;
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

  await stripe.setDefaultPaymentMethod({
    customerId: billing.stripeCustomerId,
    subscriptionId: billing.stripeSubscriptionId,
    paymentMethodId: card.paymentMethodId,
    email: session.customer_details?.email ?? null,
    name: session.customer_details?.name ?? null,
  });
  if (org.billingStatus === "past_due" || billing.stripeSubscriptionStatus === "past_due" || billing.stripeSubscriptionStatus === "unpaid") {
    // Retry the open invoice on the new card at once (4.5 point 4).
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

async function onSubscriptionChanged(
  subId: string,
  now: Date,
  invoice?: { invoiceId: string | null; billingReason: string | null },
): Promise<BillingEventResult> {
  // The event's own copy may be stale; Stripe's current one decides, its
  // metadata included (purpose "club-fee" and the orgId).
  const sub = await requireStripe().retrieveSubscription(subId);
  if (!isClubFeeMetadata(sub.metadata)) return ignored("not-club-fee");
  const orgId = sub.metadata.orgId;
  const out = await syncSubscription(orgId, sub, now);
  if (out.action !== "synced") return { action: out.action, orgId };

  // Back on after a recovered payment (not a fresh Checkout, whose own
  // "card added" DM says so): one "resumed" DM to the billing contact.
  if (out.resumed && !out.adopted && isBillingEnabled() && invoice?.billingReason !== "subscription_create") {
    const org = await loadOrg(orgId);
    const contact = await loadBillingContactUserId(orgId);
    const after = await loadBilling(orgId);
    if (org && contact) {
      await queueBillingDm({
        orgId,
        kind: "resumed",
        cycleKey: (after?.resumedAt ?? now).toISOString(),
        userId: contact,
        text: () => resumedText(org.language, { club: org.name }),
      });
    }
  }
  return { action: "synced", orgId };
}
