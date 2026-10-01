/**
 * Club fee billing, slice B3: the billing page's four card actions.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, section 4.5 ("every
 * server action re-checks the guard, never trusting that the page was
 * shown").
 *
 * Every action: signed in, then `requireClubBillingAccess` AGAIN (with the
 * web's flag), then the billing module, which refuses a role it does not
 * serve. No database, no Stripe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`REDIRECT ${to}`);
  }
}

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  flag: vi.fn(),
  requireAccess: vi.fn(),
  startClubCheckout: vi.fn(),
  startCardReplace: vi.fn(),
  openClubPortal: vi.fn(),
  removeMyCard: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/billing-flag", () => ({ billingUiEnabledForRequest: h.flag }));
vi.mock("@/lib/club-billing", () => ({
  requireClubBillingAccess: h.requireAccess,
  BillingAccessDenied: class BillingAccessDenied extends Error {},
}));
vi.mock("@/lib/club-billing-stripe", () => ({
  startClubCheckout: h.startClubCheckout,
  startCardReplace: h.startCardReplace,
  openClubPortal: h.openClubPortal,
  removeMyCard: h.removeMyCard,
}));

import { addCardAction, openPortalAction, removeMyCardAction, useMyCardAction } from "../club-billing";

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Redirect) return err.to;
    throw err;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "colin" } });
  h.flag.mockResolvedValue(true);
  h.requireAccess.mockResolvedValue({ role: "contact", snapshot: {} });
});

const ACTIONS = [
  ["addCardAction", addCardAction, h.startClubCheckout],
  ["useMyCardAction", useMyCardAction, h.startCardReplace],
  ["openPortalAction", openPortalAction, h.openClubPortal],
] as const;

describe("each action re-checks who the viewer is", () => {
  for (const [name, action, lib] of ACTIONS) {
    it(`${name}: the guard runs on EVERY call, with the web's flag, and the role is passed on`, async () => {
      lib.mockResolvedValue({ ok: true, url: "https://checkout.stripe.test/x" });
      expect(await redirectOf(action("org1"))).toBe("https://checkout.stripe.test/x");
      expect(await redirectOf(action("org1"))).toBe("https://checkout.stripe.test/x");
      expect(h.requireAccess).toHaveBeenCalledTimes(2);
      expect(h.requireAccess).toHaveBeenCalledWith("colin", "org1", { flagOn: true });
      expect(lib).toHaveBeenCalledWith({ orgId: "org1", userId: "colin", role: "contact" });
    });

    it(`${name}: signed out goes to /login and nothing runs`, async () => {
      h.auth.mockResolvedValue(null);
      expect(await redirectOf(action("org1"))).toBe("/login");
      expect(h.requireAccess).not.toHaveBeenCalled();
      expect(lib).not.toHaveBeenCalled();
    });

    it(`${name}: no access (a plain player, the flag off, an exempt club) goes home and nothing runs`, async () => {
      h.requireAccess.mockRejectedValue(new Error("No billing access"));
      expect(await redirectOf(action("org1"))).toBe("/");
      expect(lib).not.toHaveBeenCalled();
    });

    it(`${name}: a viewer is refused by the billing module and lands back on the page`, async () => {
      h.requireAccess.mockResolvedValue({ role: "viewer", snapshot: {} });
      lib.mockResolvedValue({ ok: false, reason: "not-allowed" });
      expect(await redirectOf(action("org1"))).toBe("/billing/org1?notice=failed");
      expect(lib).toHaveBeenCalledWith({ orgId: "org1", userId: "colin", role: "viewer" });
    });

    it(`${name}: a Stripe error lands back on the page, never a crash`, async () => {
      lib.mockRejectedValue(new Error("stripe down"));
      expect(await redirectOf(action("org1"))).toBe("/billing/org1?notice=failed");
    });
  }

  it("Add a card: not set up, or a card already paying, say so", async () => {
    h.startClubCheckout.mockResolvedValue({ ok: false, reason: "not-set-up" });
    expect(await redirectOf(addCardAction("org1"))).toBe("/billing/org1?notice=not-set-up");
    h.startClubCheckout.mockResolvedValue({ ok: false, reason: "already-subscribed" });
    expect(await redirectOf(addCardAction("org1"))).toBe("/billing/org1?notice=already");
  });
});

describe("Remove my card", () => {
  it("re-checks the guard, removes, and lands on the page with the 'removed' notice", async () => {
    h.requireAccess.mockResolvedValue({ role: "card-holder", snapshot: {} });
    h.removeMyCard.mockResolvedValue({ ok: true });
    expect(await redirectOf(removeMyCardAction("org1"))).toBe("/billing/org1?notice=removed");
    expect(h.requireAccess).toHaveBeenCalledWith("colin", "org1", { flagOn: true });
    expect(h.removeMyCard).toHaveBeenCalledWith({ orgId: "org1", userId: "colin", role: "card-holder" });
  });

  it("anyone else is refused by the billing module", async () => {
    h.removeMyCard.mockResolvedValue({ ok: false, reason: "not-allowed" });
    expect(await redirectOf(removeMyCardAction("org1"))).toBe("/billing/org1?notice=failed");
  });

  it("no access: home, nothing removed", async () => {
    h.requireAccess.mockRejectedValue(new Error("No billing access"));
    expect(await redirectOf(removeMyCardAction("org1"))).toBe("/");
    expect(h.removeMyCard).not.toHaveBeenCalled();
  });
});
