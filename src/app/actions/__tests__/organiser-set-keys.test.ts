/**
 * F3 (2026-10-05): every setting the organiser saves on /admin/settings is
 * recorded in `settingsSetByOrganiser`, so the learned setup never
 * overrides it. setWeeklyRoutine is pinned in weekly-routine.test.ts; this
 * pins the feature toggles and the language. Mocked auth and db.
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

const { setOrgFeature, setOrgLanguage } = await import("../org");

beforeEach(() => {
  vi.clearAllMocks();
  orgUpdate.mockResolvedValue({});
});

describe("the organiser's own choices are recorded", () => {
  it("a feature toggle (payment tracking)", async () => {
    await setOrgFeature("org-1", "paymentTracking", false);
    expect(orgUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { paymentTrackingEnabled: false, settingsSetByOrganiser: { push: "paymentTracking" } },
    });
  });
  it("the language", async () => {
    await setOrgLanguage("org-1", "tr");
    expect(orgUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { language: "tr", settingsSetByOrganiser: { push: "language" } },
    });
  });
});
