/**
 * The CLUB FEE billing webhook (club fee billing, slice B3).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2, 5.1 and 5.3.
 *
 * NOT the match fee webhook. /api/stripe/webhook is the Connect endpoint
 * ("Connected accounts" scope, STRIPE_WEBHOOK_SECRET) for players paying
 * their collectors. This one is MatchTime's own account ("Your account"
 * scope) with ITS OWN secret, STRIPE_BILLING_WEBHOOK_SECRET, so an event
 * delivered to the wrong route fails its signature check here and is
 * refused rather than mis-applied.
 *
 * Register (test mode first, then live), Developers, Webhooks, Add
 * destination, "Your account":
 *   URL:    https://matchtime.ai/api/stripe/billing-webhook
 *   Events: checkout.session.completed
 *           customer.subscription.created
 *           customer.subscription.updated
 *           customer.subscription.deleted
 *           invoice.paid
 *           invoice.payment_failed
 *           invoice.payment_action_required
 *           payment_method.detached
 *
 * Public route (src/lib/public-paths.ts allows /api/stripe): the
 * signature is the auth. Everything after verification is in
 * `processBillingWebhook` (club-billing-stripe.ts): BillingEvent
 * idempotency, purpose "club-fee" only, a fresh read of the subscription,
 * and every state move through the one writer.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { processBillingWebhook } from "@/lib/club-billing-stripe";
import { billingStripeConfig, verifyBillingWebhook } from "@/lib/stripe-billing";

export async function POST(request: Request) {
  const secret = billingStripeConfig().webhookSecret;
  if (!secret) return NextResponse.json({ ok: true, ignored: "billing-webhook-not-configured" });
  const sig = request.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "no signature" }, { status: 400 });

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = verifyBillingWebhook(payload, sig, secret);
  } catch (err) {
    console.error("[billing-webhook] signature verification failed:", (err as Error).message);
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  const r = await processBillingWebhook(event);
  return NextResponse.json(r.body, { status: r.status });
}
