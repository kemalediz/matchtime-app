/**
 * Stripe webhook (2026-06-03). Receives events from Stripe; on a
 * completed Checkout we mark the player's attendance paid.
 *
 * Register at Stripe → Developers → Webhooks → Add endpoint:
 *   URL:   https://matchtime.ai/api/stripe/webhook
 *   Event: checkout.session.completed (+ checkout.session.async_payment_succeeded
 *          for Pay-by-Bank, which can settle asynchronously)
 * Then put the signing secret in env as STRIPE_WEBHOOK_SECRET.
 *
 * Public route (no session) — allowlisted in middleware. Stripe's
 * signature check is the auth.
 */

import { NextResponse } from "next/server";
import { constructWebhookEvent, isStripeConfigured } from "@/lib/stripe";
import { applyCheckoutPaid } from "@/lib/payment-flow";
import type Stripe from "stripe";

export async function POST(request: Request) {
  if (!isStripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: true, ignored: "stripe-not-configured" });
  }
  const sig = request.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "no signature" }, { status: 400 });

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(payload, sig);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err);
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await applyCheckoutPaid(event.data.object as Stripe.Checkout.Session);
        break;
      default:
        // ignore other events
        break;
    }
  } catch (err) {
    console.error(`[stripe-webhook] handler error for ${event.type}:`, err);
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
