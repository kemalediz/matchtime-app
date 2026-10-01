/**
 * Club fee billing, slice B4: naming a new money collector tells them,
 * once, that they now look after the club fee card (plan 4.5 point 2).
 * `setPaymentHolder` makes ONE call, after its own write; the rules of
 * who is told (billed clubs only, once per collector, daytime) live in
 * `onBillingContactChanged` (club-billing-b4.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const orgUpdate = vi.fn(async () => {
  calls.push("update");
  return {};
});
const membership = vi.fn();
const changed = vi.fn(async () => {
  calls.push("billing");
  return "queued";
});

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u-admin" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn(async () => undefined), isSuperadmin: vi.fn(async () => false) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { organisation: { update: orgUpdate }, membership: { findUnique: membership } },
}));
vi.mock("@/lib/club-billing-dms", () => ({ onBillingContactChanged: changed }));

const { setPaymentHolder } = await import("@/app/actions/payments");

beforeEach(() => {
  calls.length = 0;
  changed.mockClear();
  membership.mockReset().mockResolvedValue({ user: { name: "Cole", phoneNumber: "+447700900003" } });
});

describe("setPaymentHolder and the club fee", () => {
  it("after saving the collector, asks billing to tell them (one call, after the write)", async () => {
    await expect(setPaymentHolder("org-1", "u-cole")).resolves.toEqual({ ok: true, name: "Cole" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("org-1");
    expect(calls).toEqual(["update", "billing"]);
  });

  it("a refused collector (no phone) changes nothing and tells nobody", async () => {
    membership.mockResolvedValue({ user: { name: "Nophone", phoneNumber: null } });
    await expect(setPaymentHolder("org-1", "u-x")).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();
  });

  it("a billing failure never fails the collector change", async () => {
    changed.mockRejectedValueOnce(new Error("db down"));
    await expect(setPaymentHolder("org-1", "u-cole")).resolves.toEqual({ ok: true, name: "Cole" });
  });
});
