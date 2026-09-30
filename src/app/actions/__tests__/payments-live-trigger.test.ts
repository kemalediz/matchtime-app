/**
 * The two switches that make payment collection live each ask for the
 * announcement, with the state BEFORE their own write (2026-09-30).
 * `lib/payments-live-announce.ts` decides whether anything is posted;
 * these tests pin that both call sites hand it the right `wasLive`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const announce = vi.fn();
const readLive = vi.fn();
const orgUpdate = vi.fn();
const orgFindUnique = vi.fn();
const chargesEnabled = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u-kemal" } }) }));
vi.mock("@/lib/org", () => ({
  requireOrgAdmin: vi.fn(async () => undefined),
  isSuperadmin: vi.fn(async () => false),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    organisation: {
      update: (...a: unknown[]) => orgUpdate(...a),
      findUnique: (...a: unknown[]) => orgFindUnique(...a),
    },
  },
}));
vi.mock("@/lib/stripe", () => ({
  isStripeConfigured: () => true,
  accountChargesEnabled: (...a: unknown[]) => chargesEnabled(...a),
  createConnectAccount: vi.fn(),
  createOnboardingLink: vi.fn(),
  createDashboardLoginLink: vi.fn(),
  createCheckoutSession: vi.fn(),
}));
vi.mock("@/lib/payments-live-announce", () => ({
  announcePaymentsLiveIfJustLive: (...a: unknown[]) => announce(...a),
  readPaymentLiveState: (...a: unknown[]) => readLive(...a),
}));

const { refreshCollectorStatus } = await import("@/app/actions/payments");
const { setOrgFeature } = await import("@/app/actions/org");

beforeEach(() => {
  announce.mockReset().mockResolvedValue({ announced: true });
  readLive.mockReset();
  orgUpdate.mockReset().mockResolvedValue({});
  orgFindUnique.mockReset().mockResolvedValue({ stripeConnectAccountId: "acct_1" });
  chargesEnabled.mockReset();
});

describe("refreshCollectorStatus: Stripe says the account can take charges", () => {
  it("asks for the announcement with the state before the write", async () => {
    readLive.mockResolvedValue(false);
    chargesEnabled.mockResolvedValue(true);
    await refreshCollectorStatus("org-1");
    expect(orgUpdate).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith("org-1", { wasLive: false });
    // Read BEFORE the write.
    expect(readLive.mock.invocationCallOrder[0]).toBeLessThan(orgUpdate.mock.invocationCallOrder[0]);
  });

  it("a club already live (every settings page load at Sutton) passes wasLive true", async () => {
    readLive.mockResolvedValue(true);
    chargesEnabled.mockResolvedValue(true);
    await refreshCollectorStatus("org-1");
    expect(announce).toHaveBeenCalledWith("org-1", { wasLive: true });
  });

  it("a failed announcement never fails the refresh", async () => {
    readLive.mockResolvedValue(false);
    chargesEnabled.mockResolvedValue(true);
    announce.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(refreshCollectorStatus("org-1")).resolves.toEqual({ chargesEnabled: true });
    spy.mockRestore();
  });
});

describe("setOrgFeature: the organiser switches payment collection on", () => {
  it("asks for the announcement with the state before the write", async () => {
    readLive.mockResolvedValue(false);
    await setOrgFeature("org-1", "paymentCollection", true);
    expect(announce).toHaveBeenCalledWith("org-1", { wasLive: false });
    expect(readLive.mock.invocationCallOrder[0]).toBeLessThan(orgUpdate.mock.invocationCallOrder[0]);
  });

  it("switching it OFF asks for nothing", async () => {
    await setOrgFeature("org-1", "paymentCollection", false);
    expect(announce).not.toHaveBeenCalled();
  });

  it("any other feature asks for nothing", async () => {
    await setOrgFeature("org-1", "bench", true);
    expect(readLive).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });
});
