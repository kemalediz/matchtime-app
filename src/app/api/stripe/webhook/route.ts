/**
 * Stripe webhook (2026-06-03; payment-outcome hardening 2026-08-31).
 * Receives Checkout events from Stripe and applies them to the player's
 * attendance — marking paid ONLY when the money genuinely settled.
 *
 * Register at Stripe → Developers → Webhooks → Add endpoint. MatchTime
 * uses Connect DIRECT charges, so the destination MUST be scoped to
 * **Connected accounts** — a platform-scoped endpoint receives nothing
 * (2026-06-09 incident, see MDs/SESSION-HANDOFF-2026-06-09-payments-golive.md):
 *   URL:    https://matchtime.ai/api/stripe/webhook
 *   Events: checkout.session.completed
 *           checkout.session.async_payment_succeeded
 *           checkout.session.async_payment_failed   ← REQUIRED (2026-08-31)
 *           checkout.session.expired                 (optional, ignored)
 * Then put the signing secret in env as STRIPE_WEBHOOK_SECRET.
 *
 * `async_payment_failed` is not optional now Pay by Bank is live: a bank
 * debit can complete the Checkout Session and FAIL days later. Without
 * that event a failed payment reads as settled forever. See
 * src/lib/payment-outcome.ts.
 *
 * Public route (no session) — allowlisted in middleware. Stripe's
 * signature check is the auth.
 */

import { NextResponse } from "next/server";
import { constructWebhookEvent, isStripeConfigured } from "@/lib/stripe";
import { applyCheckoutEvent } from "@/lib/payment-flow";
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
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        // Whether the event actually means "paid" is decided in
        // lib/payment-outcome.ts — completion alone is NOT payment for
        // delayed-notification methods like Pay by Bank.
        const result = await applyCheckoutEvent(
          event.type,
          event.data.object as Stripe.Checkout.Session,
        );
        return NextResponse.json({ received: true, ...result });
      }
      default:
        // ignore other events (refunds included — see payment-outcome.ts)
        break;
    }
  } catch (err) {
    console.error(`[stripe-webhook] handler error for ${event.type}:`, err);
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
