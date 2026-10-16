/**
 * Payment tracking is hidden for now (Kemal, 2026-10-16): the setting is
 * not offered, so the server action that saves the Bot features switches
 * refuses to turn it ON. Turning it OFF still works, so a club that has it
 * on can always leave. Mocked auth and db.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgUpdate = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u-admin" } }) }));
vi.mock("@/lib/db", () => ({ db: { organisation: { update: (...a: unknown[]) => orgUpdate(...a) } } }));
vi.mock("@/lib/org", () => ({
  isSuperadmin: vi.fn(),
  getCurrentOrgId: vi.fn(),
  setCurrentOrgId: vi.fn(),
  requireOrgAdmin: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { setOrgFeature } = await import("../org");

beforeEach(() => {
  vi.clearAllMocks();
  orgUpdate.mockResolvedValue({});
});

describe("setOrgFeature: payment tracking is hidden", () => {
  it("refuses to switch payment tracking on, and writes nothing", async () => {
    await expect(setOrgFeature("org-1", "paymentTracking", true)).rejects.toThrow(/not available/i);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("still switches it off", async () => {
    await setOrgFeature("org-1", "paymentTracking", false);
    expect(orgUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { paymentTrackingEnabled: false, settingsSetByOrganiser: { push: "paymentTracking" } },
    });
  });

  it("other switches are unaffected", async () => {
    await setOrgFeature("org-1", "momVoting", true);
    expect(orgUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { featureMomVoting: true, settingsSetByOrganiser: { push: "momVoting" } },
    });
  });
});
