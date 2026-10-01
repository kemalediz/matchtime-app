/**
 * /api/stripe/billing-webhook (club fee billing, slice B3, plan 5.3):
 * verified with ITS OWN secret, STRIPE_BILLING_WEBHOOK_SECRET. An event
 * signed for the Connect endpoint is refused here. Signatures are made
 * locally with a test secret; no Stripe call, no database.
 */
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("@/lib/club-billing-stripe", () => ({ processBillingWebhook: h.process }));

import { POST } from "../route";

const BILLING_SECRET = "whsec_unit_billing";
const CONNECT_SECRET = "whsec_unit_connect";
const signer = new Stripe("sk_test_signing_only");
const ENV = { ...process.env };

function req(payload: string, sig: string | null): Request {
  return new Request("http://localhost/api/stripe/billing-webhook", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body: payload,
  });
}
const payload = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", data: { object: { id: "in_1" } } });

beforeEach(() => {
  process.env.STRIPE_BILLING_WEBHOOK_SECRET = BILLING_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = CONNECT_SECRET;
  h.process.mockResolvedValue({ status: 200, body: { received: true, action: "synced" } });
});
afterEach(() => {
  process.env = { ...ENV };
  vi.clearAllMocks();
});

describe("billing webhook route", () => {
  it("accepts an event signed with the billing secret and hands it to the processor", async () => {
    const res = await POST(req(payload, signer.webhooks.generateTestHeaderString({ payload, secret: BILLING_SECRET })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, action: "synced" });
    expect(h.process).toHaveBeenCalledWith(expect.objectContaining({ id: "evt_1", type: "invoice.paid" }));
  });

  it("refuses an event signed with the CONNECT secret (400, nothing processed)", async () => {
    const res = await POST(req(payload, signer.webhooks.generateTestHeaderString({ payload, secret: CONNECT_SECRET })));
    expect(res.status).toBe(400);
    expect(h.process).not.toHaveBeenCalled();
  });

  it("refuses a request with no signature", async () => {
    expect((await POST(req(payload, null))).status).toBe(400);
    expect(h.process).not.toHaveBeenCalled();
  });

  it("review fix 6: no billing secret configured: 503, so Stripe keeps the event and retries once it is set", async () => {
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    const res = await POST(req(payload, "t=1,v1=x"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "billing-webhook-not-configured" });
    expect(h.process).not.toHaveBeenCalled();
  });

  it("a handler failure is a 500, so Stripe retries", async () => {
    h.process.mockResolvedValue({ status: 500, body: { error: "handler error" } });
    const res = await POST(req(payload, signer.webhooks.generateTestHeaderString({ payload, secret: BILLING_SECRET })));
    expect(res.status).toBe(500);
  });
});
