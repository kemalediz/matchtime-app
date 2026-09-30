/**
 * /admin/settings "Weekly routine" (2026-09-30): the one server action
 * every weekly-routine setting goes through. Slice 1 has one key, the
 * rolling squad; slices 2 and 3 add theirs to the same action.
 *
 * auth / db / org / next-cache are mocked: no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const orgUpdate = vi.fn();
const requireOrgAdmin = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({
  db: { organisation: { update: (...a: unknown[]) => orgUpdate(...a) } },
}));
vi.mock("@/lib/org", () => ({
  isSuperadmin: vi.fn(),
  getCurrentOrgId: vi.fn(),
  setCurrentOrgId: vi.fn(),
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { setWeeklyRoutine } = await import("../org");

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u-hamzah" } });
  orgUpdate.mockResolvedValue({ rollingSquadEnabled: true });
  requireOrgAdmin.mockResolvedValue(undefined);
});

describe("setWeeklyRoutine", () => {
  it("turns the rolling squad on for an admin", async () => {
    const res = await setWeeklyRoutine("org-fnf", { rollingSquad: true });
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-hamzah", "org-fnf");
    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "org-fnf" }, data: { rollingSquadEnabled: true } }),
    );
    expect(res).toEqual({ rollingSquad: true });
  });

  it("refuses a non-admin", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(setWeeklyRoutine("org-fnf", { rollingSquad: true })).rejects.toThrow("Admin access required");
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    authMock.mockResolvedValue(null);
    await expect(setWeeklyRoutine("org-fnf", { rollingSquad: true })).rejects.toThrow("Not authenticated");
  });

  it("refuses an empty or malformed patch rather than writing nothing silently", async () => {
    await expect(setWeeklyRoutine("org-fnf", {})).rejects.toThrow();
    await expect(
      setWeeklyRoutine("org-fnf", { rollingSquad: "yes" } as unknown as { rollingSquad: boolean }),
    ).rejects.toThrow();
    expect(orgUpdate).not.toHaveBeenCalled();
  });
});
