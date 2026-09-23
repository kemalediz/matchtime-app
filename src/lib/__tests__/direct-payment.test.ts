/**
 * markDirectPaymentPending: the ONE implementation of "settle directly".
 *
 * Two callers share it (2026-09-23): the pay page's "Pay the collector
 * directly" button (`payDirect` in app/actions/payments.ts) and a player
 * who just DMs MatchTime "Paid" (`lib/payment-claim.ts`). Same pending
 * state, same collector notification, same repeat suppression. These
 * tests pin the shared behaviour with the database mocked out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindUnique = vi.fn();
const attendanceFindUnique = vi.fn();
const attendanceUpdateMany = vi.fn();
const userFindUnique = vi.fn();
const botJobCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    attendance: {
      findUnique: (...a: unknown[]) => attendanceFindUnique(...a),
      updateMany: (...a: unknown[]) => attendanceUpdateMany(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: () => "tok",
  MAGIC_LINK_TTL: { actionNudge: 60, bookmark: 60 },
}));
vi.mock("@/lib/short-link", () => ({
  buildShortMagicLinkUrl: async () => "https://mt.example/s/collect",
}));

import { markDirectPaymentPending } from "@/lib/direct-payment";
import { ALREADY_PAID_REASON } from "@/lib/payment-outcome";

const MATCH = {
  id: "m1",
  feePerPlayer: 8,
  status: "COMPLETED",
  date: new Date("2026-09-22T20:30:00Z"),
  activity: {
    name: "Tuesday 7-a-side",
    orgId: "org-sutton",
    org: {
      id: "org-sutton",
      name: "Sutton FC",
      language: "en",
      stripeConnectAccountId: "acct_1",
      stripeChargesEnabled: true,
      payMethodPayByBank: false,
      payMethodCard: true,
      payMethodDirect: true,
      paymentHolderId: "u-kemal",
    },
  },
};

function attendance(over: Record<string, unknown> = {}) {
  return {
    matchId: "m1",
    userId: "u-abid",
    status: "CONFIRMED",
    paidAt: null,
    directPendingAt: null,
    paymentMethod: null,
    paymentQuantity: 1,
    ...over,
  };
}

const collectorDms = () =>
  botJobCreate.mock.calls.map((c) => (c[0] as { data: { phone: string; text: string } }).data);

beforeEach(() => {
  vi.clearAllMocks();
  matchFindUnique.mockResolvedValue(MATCH);
  attendanceFindUnique.mockResolvedValue(attendance());
  attendanceUpdateMany.mockResolvedValue({ count: 1 });
  userFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === "u-kemal"
      ? { name: "Kemal Ediz", phoneNumber: "+447700900001" }
      : { name: "Abid Kazmi", phoneNumber: "+447700900009" },
  );
  botJobCreate.mockResolvedValue({});
});

describe("a fresh direct payment", () => {
  it("sets the pending state and notifies the collector once (pay page wording)", async () => {
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", quantity: 1, via: "pay-page" });
    expect(r).toMatchObject({ ok: true, alreadyPending: false, amount: 8, quantity: 1, collectorNotified: true });

    // The write is conditional on the row still being unpaid AND not yet
    // pending, which is what makes the "one nudge per player per match"
    // rule hold under two concurrent taps (or a tap and a DM).
    const first = attendanceUpdateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(first.where).toMatchObject({ matchId: "m1", userId: "u-abid", paidAt: null, directPendingAt: null });
    expect(first.data).toMatchObject({ paymentMethod: "direct", paymentAmount: 8, paymentQuantity: 1 });
    expect(first.data.directPendingAt).toBeInstanceOf(Date);

    const dms = collectorDms();
    expect(dms).toHaveLength(1);
    expect(dms[0].phone).toBe("447700900001");
    expect(dms[0].text).toContain("*Abid Kazmi* says they'll pay you directly for *Tuesday 7-a-side*");
    expect(dms[0].text).toContain("*£8*");
    expect(dms[0].text).toContain("https://mt.example/s/collect");
  });

  it("a DM claim says the player HAS paid, not that they will", async () => {
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r).toMatchObject({ ok: true, alreadyPending: false, collectorNotified: true });
    const dms = collectorDms();
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toContain("*Abid Kazmi* says they've paid you directly for *Tuesday 7-a-side*");
  });

  it("the collector's notice is in the org's language", async () => {
    matchFindUnique.mockResolvedValue({
      ...MATCH,
      activity: { ...MATCH.activity, org: { ...MATCH.activity.org, language: "tr" } },
    });
    await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(collectorDms()[0].text).toContain("ödeme yaptığını yazdı");
  });

  it("guests on the pay page multiply the amount", async () => {
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", quantity: 3, via: "pay-page" });
    expect(r).toMatchObject({ ok: true, amount: 24, quantity: 3 });
    expect(collectorDms()[0].text).toContain("(3 players)");
  });
});

describe("repeat suppression (a second tap, or a second 'paid')", () => {
  it("refreshes the pending state and does NOT re-DM the collector", async () => {
    attendanceFindUnique.mockResolvedValue(
      attendance({ directPendingAt: new Date("2026-09-22T22:00:00Z"), paymentMethod: "direct" }),
    );
    // The conditional first write finds nothing to do: already pending.
    attendanceUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r).toMatchObject({ ok: true, alreadyPending: true, collectorNotified: false });
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("a DM claim does not overwrite the guest count chosen on the pay page", async () => {
    attendanceFindUnique.mockResolvedValue(
      attendance({ directPendingAt: new Date(), paymentMethod: "direct", paymentQuantity: 2 }),
    );
    attendanceUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r).toMatchObject({ ok: true, quantity: 2, amount: 16 });
  });

  it("a DM claim after an abandoned card checkout does not guess a guest count", async () => {
    attendanceFindUnique.mockResolvedValue(attendance({ paymentMethod: "card", paymentQuantity: 2 }));
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r).toMatchObject({ ok: true, quantity: 1, amount: 8 });
  });
});

describe("blocked: nothing is written and nobody is DM'd", () => {
  it("already paid", async () => {
    attendanceFindUnique.mockResolvedValue(attendance({ paidAt: new Date() }));
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r).toEqual({ ok: false, reason: ALREADY_PAID_REASON });
    expect(attendanceUpdateMany).not.toHaveBeenCalled();
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("no fee set yet", async () => {
    matchFindUnique.mockResolvedValue({ ...MATCH, feePerPlayer: null });
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r).toEqual({ ok: false, reason: "No fee set for this match yet" });
    expect(attendanceUpdateMany).not.toHaveBeenCalled();
  });

  it("not in the squad", async () => {
    attendanceFindUnique.mockResolvedValue(null);
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r).toEqual({ ok: false, reason: "You weren't in this squad" });
    expect(attendanceUpdateMany).not.toHaveBeenCalled();
  });

  it("direct payment switched off for the org", async () => {
    matchFindUnique.mockResolvedValue({
      ...MATCH,
      activity: { ...MATCH.activity, org: { ...MATCH.activity.org, payMethodDirect: false } },
    });
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "pay-page" });
    expect(r).toEqual({ ok: false, reason: "Direct payment is off" });
    expect(attendanceUpdateMany).not.toHaveBeenCalled();
  });

  it("the collector confirmed it between the read and the write", async () => {
    attendanceUpdateMany.mockResolvedValue({ count: 0 });
    const r = await markDirectPaymentPending({ userId: "u-abid", matchId: "m1", via: "dm-claim" });
    expect(r.ok).toBe(false);
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});
