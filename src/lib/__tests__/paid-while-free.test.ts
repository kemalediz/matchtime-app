/**
 * MONEY THAT ARRIVES AFTER A FREE PLACE (review of #301, item 6). A player
 * can start a card or Pay by Bank checkout, be made free, and then the
 * payment settles. Money moved, so the row is marked paid (paid wins), and
 * the organisers are told once, in their admin channel, that a refund may
 * be due. MatchTime never refunds by itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

const notices: Array<{ orgId: string; text: string }> = [];
let row: Record<string, unknown> | null = null;
let updated = 1;

vi.mock("../db", () => ({
  db: {
    attendance: {
      updateMany: async () => ({ count: updated }),
      findUnique: async () => row,
    },
    match: {
      findUnique: async () => ({
        date: new Date("2026-10-16T19:00:00Z"),
        activity: { orgId: "org", org: { language: "en" } },
      }),
    },
    user: { findUnique: async () => ({ name: "Bilal Ahmed" }) },
  },
}));
vi.mock("../admin-channel", () => ({
  sendAdminNotice: async (n: { orgId: string; text: string }) => {
    notices.push({ orgId: n.orgId, text: n.text });
    return { channel: "admin-group", queued: 1 };
  },
}));

import { applyCheckoutEvent } from "../payment-flow";

const session = (o: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: "cs_1",
    payment_status: "paid",
    amount_total: 833,
    metadata: { matchId: "m1", userId: "u1", quantity: "1", orgId: "org" },
    ...o,
  }) as unknown as Stripe.Checkout.Session;

beforeEach(() => {
  notices.length = 0;
  updated = 1;
});

describe("applyCheckoutEvent on a free place", () => {
  it("marks it paid (money moved) and tells the organisers a refund may be due", async () => {
    row = { feeWaivedAt: new Date("2026-10-16T20:00:00Z") };
    expect(await applyCheckoutEvent("checkout.session.completed", session())).toEqual({ action: "marked-paid" });
    expect(notices).toEqual([
      { orgId: "org", text: "💷 Bilal Ahmed paid £8.33 for Fri 16 Oct, but they're on a free place. Refund it in Stripe if they should play free." },
    ]);
  });

  it("an ordinary payment: no notice", async () => {
    row = { feeWaivedAt: null };
    await applyCheckoutEvent("checkout.session.completed", session());
    expect(notices).toHaveLength(0);
  });

  it("a repeat delivery (nothing marked): no second notice", async () => {
    row = { feeWaivedAt: new Date(), paidAt: new Date(), stripeSessionId: "cs_1" };
    updated = 0;
    await applyCheckoutEvent("checkout.session.completed", session());
    expect(notices).toHaveLength(0);
  });
});
