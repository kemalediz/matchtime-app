/**
 * Stripe wrapper (2026-06-03) — gated on env so the app builds and runs
 * with payments OFF until keys exist.
 *
 * Setup required (Kemal, one-time): a Cressoft Stripe account with
 * Connect enabled, then these env vars:
 *   STRIPE_SECRET_KEY        sk_test… / sk_live…
 *   STRIPE_WEBHOOK_SECRET    whsec_…   (set after the webhook is created)
 *   STRIPE_CONNECT_CLIENT_ID ca_…      (Connect → Settings)
 *   NEXT_PUBLIC_APP_URL / NEXTAUTH_URL for redirect/return URLs.
 *
 * Model: each org's money collector has their own connected Express
 * account (`Organisation.stripeConnectAccountId`). Charges are created
 * ON that account, so funds settle to the collector and Stripe pays out
 * to their bank. MatchTime never holds the money.
 *
 * Everything here returns a clear "not configured" signal when keys are
 * missing, so callers can fall back to the "pay collector directly"
 * method gracefully.
 */

import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

function client(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY not set — Stripe is not configured");
  }
  if (!_stripe) {
    // No explicit apiVersion — use the SDK's pinned default; bump the
    // SDK deliberately when upgrading.
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { typescript: true });
  }
  return _stripe;
}

function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    "https://matchtime.ai"
  ).replace(/\/$/, "");
}

// ─── Connect onboarding (money collector links their bank) ───────────

/** Create an Express connected account for a money collector. Returns
 *  the new account id. */
export async function createConnectAccount(opts: {
  email?: string | null;
  orgName: string;
}): Promise<string> {
  const acct = await client().accounts.create({
    type: "express",
    country: "GB",
    email: opts.email ?? undefined,
    business_type: "individual",
    capabilities: {
      transfers: { requested: true },
      card_payments: { requested: true },
    },
    // Pre-fill the whole business profile so Stripe's "Business
    // information" step arrives COMPLETE — ordinary collectors only then
    // have to confirm identity + add their bank, not describe a
    // "business" (mcc + url + product_description are what Stripe marks
    // incomplete otherwise).
    business_profile: {
      name: opts.orgName,
      mcc: "7941", // Commercial sports / athletic fields / sports clubs
      url: "https://matchtime.ai",
      product_description:
        "Collecting amateur sports match fees from players to cover pitch / venue hire, organised via MatchTime.",
    },
    metadata: { matchtimeOrg: opts.orgName },
  });
  return acct.id;
}

/** Hosted onboarding link the collector taps to add their bank + ID. */
export async function createOnboardingLink(
  accountId: string,
  returnPath = "/admin/settings",
): Promise<string> {
  const base = appBaseUrl();
  const link = await client().accountLinks.create({
    account: accountId,
    refresh_url: `${base}${returnPath}?stripe=refresh`,
    return_url: `${base}${returnPath}?stripe=done`,
    type: "account_onboarding",
  });
  return link.url;
}

/** One-time login link to the collector's Express dashboard, where they
 *  can change their payout bank account, view payouts, and update details
 *  later — WITHOUT disconnecting or re-onboarding. Only valid once the
 *  Express account has finished onboarding. */
export async function createDashboardLoginLink(accountId: string): Promise<string> {
  const link = await client().accounts.createLoginLink(accountId);
  return link.url;
}

/** Is the connected account fully able to take charges + receive payouts? */
export async function accountChargesEnabled(accountId: string): Promise<boolean> {
  const acct = await client().accounts.retrieve(accountId);
  return !!acct.charges_enabled && !!acct.payouts_enabled;
}

// ─── Checkout (a player pays) ────────────────────────────────────────

export interface CheckoutArgs {
  connectedAccountId: string;
  /** Pounds — the TOTAL to charge (base × quantity + uplift). */
  amount: number;
  /** Pence — MatchTime's platform fee, skimmed from the connected-account
   *  charge via Stripe `application_fee_amount`. 0 = no platform fee. */
  applicationFeePence: number;
  method: "pay_by_bank" | "card";
  quantity: number;
  description: string; // line item the PAYER sees, e.g. "Tuesday 7-a-side — match fee"
  /** PaymentIntent description the COLLECTOR sees on their Stripe payments
   *  list — so they can tell who paid. e.g. "Amir - 9th June". */
  payerDescription?: string;
  metadata: Record<string, string>; // { matchId, userId, ... }
  successPath: string;
  cancelPath: string;
}

/** Create a Checkout Session ON the collector's connected account.
 *  Returns the hosted payment URL to DM the player. */
export async function createCheckoutSession(args: CheckoutArgs): Promise<string> {
  const base = appBaseUrl();
  const pence = Math.round(args.amount * 100);
  const paymentMethodTypes: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
    args.method === "pay_by_bank" ? ["pay_by_bank"] : ["card"];

  const session = await client().checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: paymentMethodTypes,
      line_items: [
        {
          quantity: 1, // amount already includes quantity; one line for clarity
          price_data: {
            currency: "gbp",
            unit_amount: pence,
            product_data: { name: args.description },
          },
        },
      ],
      // Direct charge on the collector's connected account: the platform
      // fee is skimmed to MatchTime, the rest settles to the collector.
      // The description is the collector-facing "who paid" label.
      ...(() => {
        const pi: Stripe.Checkout.SessionCreateParams.PaymentIntentData = {};
        if (args.applicationFeePence > 0) pi.application_fee_amount = args.applicationFeePence;
        if (args.payerDescription) pi.description = args.payerDescription;
        return Object.keys(pi).length ? { payment_intent_data: pi } : {};
      })(),
      metadata: args.metadata,
      success_url: `${base}${args.successPath}`,
      cancel_url: `${base}${args.cancelPath}`,
    },
    { stripeAccount: args.connectedAccountId },
  );
  return session.url!;
}

/** Verify + parse a webhook event. Throws if signature invalid. */
export function constructWebhookEvent(payload: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  return client().webhooks.constructEvent(payload, signature, secret);
}
