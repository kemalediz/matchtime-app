/**
 * The CLUB FEE billing webhook (club fee billing, slice B3; slice P2 for
 * games played: a card saved in setup mode and one invoice per month).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2, 5.2 and 5.4.
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
 *           invoice.paid
 *           invoice.payment_failed
 *           invoice.payment_action_required
 *           invoice.voided
 *           invoice.marked_uncollectible
 *           payment_method.detached
 * (customer.subscription.* are not needed any more: none exist; if they
 * arrive they are answered 200 and ignored.)
 *
 * Public route (src/lib/public-paths.ts allows /api/stripe): the
 * signature is the auth. Everything after verification is in
 * `processBillingWebhook` (club-billing-stripe.ts): BillingEvent
 * idempotency, purpose "club-fee" only, a fresh read of the invoice, the
 * month found by its id, and every state move through the one writer.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { processBillingWebhook } from "@/lib/club-billing-stripe";
import { billingStripeConfig, verifyBillingWebhook } from "@/lib/stripe-billing";

export async function POST(request: Request) {
  const secret = billingStripeConfig().webhookSecret;
  // 503, not 200: an event Stripe sends before the secret is set must be
  // retried later, never dropped as if handled (review fix 6).
  if (!secret) {
    console.error("[billing-webhook] STRIPE_BILLING_WEBHOOK_SECRET is not set: answering 503 so Stripe retries");
    return NextResponse.json({ error: "billing-webhook-not-configured" }, { status: 503 });
  }
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
