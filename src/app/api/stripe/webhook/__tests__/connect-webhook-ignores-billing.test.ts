/**
 * The CONNECT webhook (/api/stripe/webhook, match fees) must never act on
 * club fee billing (club fee billing, slice B3, plan section 2):
 *
 *   - subscription and invoice events are not handled at all;
 *   - a club fee Checkout session (purpose "club-fee", no matchId/userId)
 *     reaching it is ignored by `applyCheckoutEvent`, whatever happens;
 *   - an event signed with the BILLING secret fails its signature check.
 *
 * Signed locally with test secrets. `applyCheckoutEvent` is spied on but
 * runs for real for the club fee session (it returns before any database
 * read when the metadata has no matchId).
 */
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("@/lib/payment-flow", async () => {
  const real = await vi.importActual<typeof import("@/lib/payment-flow")>("@/lib/payment-flow");
  h.apply.mockImplementation(real.applyCheckoutEvent);
  return { ...real, applyCheckoutEvent: h.apply };
});
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: () => { throw new Error("the database must not be touched"); } }) }));

import { POST } from "../route";

const CONNECT_SECRET = "whsec_unit_connect";
const BILLING_SECRET = "whsec_unit_billing";
const signer = new Stripe("sk_test_signing_only");
const ENV = { ...process.env };

function signed(event: object, secret = CONNECT_SECRET): Request {
  const payload = JSON.stringify(event);
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret }) },
    body: payload,
  });
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_unit_never_called";
  process.env.STRIPE_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.STRIPE_BILLING_WEBHOOK_SECRET = BILLING_SECRET;
});
afterEach(() => {
  process.env = { ...ENV };
  vi.clearAllMocks();
});

const clubFeeSession = {
  id: "cs_club",
  object: "checkout.session",
  mode: "subscription",
  payment_status: "paid",
  metadata: { orgId: "org_1", payerUserId: "user_colin", purpose: "club-fee", action: "add-card" },
};

describe("the Connect webhook ignores club fee billing", () => {
  for (const type of [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
    "payment_method.detached",
  ]) {
    it(`${type}: received, not handled`, async () => {
      const res = await POST(signed({ id: `evt_${type}`, object: "event", type, data: { object: { id: "x", metadata: { purpose: "club-fee", orgId: "org_1" } } } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect(h.apply).not.toHaveBeenCalled();
    });
  }

  it("a club fee checkout.session.completed is IGNORED by applyCheckoutEvent (no matchId), nothing marked paid", async () => {
    const res = await POST(signed({ id: "evt_cs", object: "event", type: "checkout.session.completed", data: { object: clubFeeSession } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, action: "ignored", reason: "no-metadata" });
  });

  it("an event signed with the BILLING secret is refused (400)", async () => {
    const res = await POST(signed({ id: "evt_b", object: "event", type: "checkout.session.completed", data: { object: clubFeeSession } }, BILLING_SECRET));
    expect(res.status).toBe(400);
    expect(h.apply).not.toHaveBeenCalled();
  });
});
