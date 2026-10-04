/**
 * The platform owner's club fee controls (club fee billing, slice B2):
 * superadmin only, checked in the action itself; the price parsed before
 * anything is written. No database, no Stripe, nothing messaged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  isSuperadmin: vi.fn(),
  setClubPlan: vi.fn(),
  startTrial: vi.fn(),
  onPlanChanged: vi.fn(),
  flushPendingBillingNotices: vi.fn(),
  detachDroppedCard: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/org", () => ({ isSuperadmin: h.isSuperadmin }));
vi.mock("@/lib/club-billing", () => ({ setClubPlan: h.setClubPlan, startTrial: h.startTrial }));
vi.mock("@/lib/club-billing-stripe", () => ({
  onPlanChanged: h.onPlanChanged,
  flushPendingBillingNotices: h.flushPendingBillingNotices,
  detachDroppedCard: h.detachDroppedCard,
}));

import { setClubPlanAction, startFreeMonthAction } from "../club-billing-admin";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "kemal" } });
  h.isSuperadmin.mockResolvedValue(true);
  h.onPlanChanged.mockResolvedValue({ action: "none" });
  h.flushPendingBillingNotices.mockResolvedValue(1);
  process.env.STRIPE_CLUB_PRODUCT_ID = "prod_club";
});

describe("owner only", () => {
  it("a club admin who is not the superadmin is refused and nothing is written", async () => {
    h.isSuperadmin.mockResolvedValue(false);
    await expect(setClubPlanAction("org1", "free")).rejects.toThrow("Not allowed");
    await expect(startFreeMonthAction("org1")).rejects.toThrow("Not allowed");
    expect(h.setClubPlan).not.toHaveBeenCalled();
    expect(h.startTrial).not.toHaveBeenCalled();
  });

  it("signed out is refused", async () => {
    h.auth.mockResolvedValue(null);
    await expect(setClubPlanAction("org1", "standard")).rejects.toThrow("Not allowed");
  });
});

describe("setClubPlanAction", () => {
  it("Custom GBP 5.50 is written as 550 pence", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "custom", pricePence: 550, status: "trial", resumed: false });
    const r = await setClubPlanAction("org1", "custom", "5.50");
    expect(h.setClubPlan).toHaveBeenCalledWith("org1", { plan: "custom", pricePence: 550 });
    expect(r).toEqual({ ok: true, message: "Plan saved: Custom, up to £5.50 a month." });
  });

  it("a custom price out of range is refused before anything is written", async () => {
    for (const price of ["0.50", "10", "abc"]) {
      expect(await setClubPlanAction("org1", "custom", price)).toEqual({
        ok: false,
        message: "A custom price must be between £1.00 and £9.99.",
      });
    }
    expect(h.setClubPlan).not.toHaveBeenCalled();
  });

  it("Free says the club is not billed (and back on, if it was paused)", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "free", pricePence: null, status: "exempt", resumed: true });
    expect((await setClubPlanAction("org1", "free")).message).toBe(
      "Plan saved: Free. The club is not billed. MatchTime is back on in its group.",
    );
  });

  // Slice P2: after the database write has committed, `onPlanChanged`:
  // Free waives the open month and voids unpaid invoices; a price change
  // needs nothing in Stripe (the month close reads the lower price).
  it("a price change: onPlanChanged runs after the save, nothing to report", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "custom", pricePence: 500, status: "subscribed", resumed: false, billedAgain: null });
    const r = await setClubPlanAction("org1", "custom", "5");
    expect(h.onPlanChanged).toHaveBeenCalledWith("org1");
    expect(h.setClubPlan.mock.invocationCallOrder[0]).toBeLessThan(h.onPlanChanged.mock.invocationCallOrder[0]);
    expect(r).toEqual({ ok: true, message: "Plan saved: Custom, up to £5 a month." });
  });

  it("Free on a billed club: the open month is not charged and unpaid invoices are cancelled, and it says so", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "free", pricePence: null, status: "exempt", resumed: false, billedAgain: null });
    h.onPlanChanged.mockResolvedValue({ action: "forgiven", waived: 1, voided: 2, alreadyPaid: 0, failed: 0 });
    expect((await setClubPlanAction("org1", "free")).message).toBe(
      "Plan saved: Free. The club is not billed. This month is not charged. 2 unpaid invoice(s) cancelled.",
    );
  });

  it("Free with an invoice that had already been paid: says so (refund by hand)", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "free", pricePence: null, status: "exempt", resumed: false, billedAgain: null });
    h.onPlanChanged.mockResolvedValue({ action: "forgiven", waived: 0, voided: 0, alreadyPaid: 1, failed: 0 });
    expect((await setClubPlanAction("org1", "free")).message).toMatch(/had already been paid: refund by hand in Stripe/);
  });

  it("an invoice that could not be voided yet is reported, not hidden (the hourly run keeps trying)", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "free", pricePence: null, status: "exempt", resumed: false, billedAgain: null });
    h.onPlanChanged.mockResolvedValue({ action: "forgiven", waived: 0, voided: 0, alreadyPaid: 0, failed: 1 });
    const r = await setClubPlanAction("org1", "free");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/could not be cancelled in Stripe yet/);
  });

  it("a Stripe failure after saving is reported, not hidden (the plan stays saved; press again to retry)", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "standard", pricePence: null, status: "subscribed", resumed: false, billedAgain: null });
    h.onPlanChanged.mockRejectedValue(new Error("stripe down"));
    expect(await setClubPlanAction("org1", "standard")).toEqual({
      ok: false,
      message: "Plan saved: Standard, up to £9.99 a month. Stripe could not be updated (stripe down). Press Save plan again to retry.",
    });
  });

  it("review fix 10: pending billing DMs are sent after EVERY save (a retried save still sends a DM that failed)", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "standard", pricePence: null, status: "grace", resumed: false, billedAgain: null });
    await setClubPlanAction("org1", "standard");
    expect(h.flushPendingBillingNotices).toHaveBeenCalledWith("org1");
  });

  it("slice P2: Custom no longer needs a Stripe price, so it is saved without STRIPE_CLUB_PRODUCT_ID (charging checks it at each month close)", async () => {
    delete process.env.STRIPE_CLUB_PRODUCT_ID;
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "custom", pricePence: 500, status: "subscribed", resumed: false, billedAgain: null });
    expect((await setClubPlanAction("org1", "custom", "5")).ok).toBe(true);
    expect(h.setClubPlan).toHaveBeenCalled();
  });

  it("billed again after Free with the free month used: grace, and the billing contact is asked for a card", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "standard", pricePence: null, status: "grace", resumed: false, billedAgain: "grace" });
    const r = await setClubPlanAction("org1", "standard");
    expect(h.flushPendingBillingNotices).toHaveBeenCalledWith("org1");
    expect(r.message).toBe("Plan saved: Standard, up to £9.99 a month. The free month was already used, so the club has 7 days to add a card.");
  });

  // (setClubPlan writes NO pending DM for a back-to-trial: club-billing-b2.test.ts.)
  it("billed again while its free month is still running: back in trial", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "standard", pricePence: null, status: "trial", resumed: false, billedAgain: "trial" });
    const r = await setClubPlanAction("org1", "standard");
    expect(r.message).toBe("Plan saved: Standard, up to £9.99 a month. The club is back in its free month.");
  });

  it("review M1: billed again with the CONTACT's card on file: billed with it, and they are told", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "standard", pricePence: null, status: "subscribed", resumed: false, billedAgain: "subscribed", droppedCard: null });
    const r = await setClubPlanAction("org1", "standard");
    expect(r.message).toBe("Plan saved: Standard, up to £9.99 a month. The billing contact's card on file is billed again, and they get a message saying so.");
    expect(h.flushPendingBillingNotices).toHaveBeenCalledWith("org1");
    expect(h.detachDroppedCard).not.toHaveBeenCalled();
  });

  it("review M1: a PREVIOUS holder's card was on file: detached, never billed; the contact is asked for a card", async () => {
    h.setClubPlan.mockResolvedValue({
      ok: true,
      plan: "standard",
      pricePence: null,
      status: "grace",
      resumed: false,
      billedAgain: "grace",
      droppedCard: { paymentMethodId: "pm_old", holderUserId: "u_elvin" },
    });
    const r = await setClubPlanAction("org1", "standard");
    expect(h.detachDroppedCard).toHaveBeenCalledWith("org1", "pm_old");
    expect(r.message).toBe(
      "Plan saved: Standard, up to £9.99 a month. The free month was already used, so the club has 7 days to add a card. The card on file was not the billing contact's, so it was removed (never charged) and its holder is told.",
    );
  });

  it("billed again after the payer had stopped paying, or while MatchTime is out of the group: still paused", async () => {
    h.setClubPlan.mockResolvedValue({ ok: true, plan: "standard", pricePence: null, status: "paused", resumed: false, billedAgain: "paused", droppedCard: null });
    const r = await setClubPlanAction("org1", "standard");
    expect(r.message).toBe("Plan saved: Standard, up to £9.99 a month. It stays paused (the payer had stopped paying, or MatchTime is not in its group).");
  });

  it("Sutton FC's shape is refused by the writer", async () => {
    h.setClubPlan.mockResolvedValue({ ok: false, reason: "not-self-join" });
    expect(await setClubPlanAction("org-sutton", "standard")).toEqual({
      ok: false,
      message: "Only clubs that joined themselves have a plan.",
    });
  });
});

describe("startFreeMonthAction", () => {
  it("starts and says when it ends", async () => {
    h.startTrial.mockResolvedValue({ ok: true, trialEndsAt: new Date("2026-10-31T12:00:00Z") });
    expect(await startFreeMonthAction("org1")).toEqual({ ok: true, message: "Free month started. It ends on Sat 31 Oct." });
  });

  it("each refusal reads plainly", async () => {
    h.startTrial.mockResolvedValue({ ok: false, reason: "had-free-month" });
    expect(await startFreeMonthAction("org1")).toEqual({ ok: false, message: "This club has had its free month already." });
    h.startTrial.mockResolvedValue({ ok: false, reason: "flag-off" });
    expect((await startFreeMonthAction("org1")).message).toMatch(/BILLING_ENABLED/);
  });
});
