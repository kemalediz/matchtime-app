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
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/org", () => ({ isSuperadmin: h.isSuperadmin }));
vi.mock("@/lib/club-billing", () => ({ setClubPlan: h.setClubPlan, startTrial: h.startTrial }));

import { setClubPlanAction, startFreeMonthAction } from "../club-billing-admin";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "kemal" } });
  h.isSuperadmin.mockResolvedValue(true);
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
    expect(r).toEqual({ ok: true, message: "Plan saved: Custom £5.50 a month." });
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
