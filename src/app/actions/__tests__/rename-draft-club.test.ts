/**
 * /admin/settings "Organisation name": an organiser may rename the club
 * while it is still a draft. Once it is pending or approved the name is
 * what the MatchTime owner approves by, so it must not change.
 *
 * auth / db / org / next-cache are mocked: no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const orgUpdateMany = vi.fn();
const orgUpdate = vi.fn();
const requireOrgAdmin = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({
  db: {
    organisation: {
      updateMany: (...a: unknown[]) => orgUpdateMany(...a),
      update: (...a: unknown[]) => orgUpdate(...a),
    },
  },
}));
vi.mock("@/lib/org", () => ({
  isSuperadmin: vi.fn(),
  getCurrentOrgId: vi.fn(),
  setCurrentOrgId: vi.fn(),
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { renameDraftClub } = await import("../org");

/** The one club row the fake `updateMany` filters and writes. */
let club: { id: string; name: string; slug: string; approvalStatus: string };

beforeEach(() => {
  vi.clearAllMocks();
  club = { id: "org-friday", name: "Friday MT Community", slug: "friday-mt-community", approvalStatus: "draft" };
  authMock.mockResolvedValue({ user: { id: "u-organiser" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  orgUpdateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = Object.entries(where).every(([k, v]) => (club as Record<string, unknown>)[k] === v);
      if (!hit) return { count: 0 };
      Object.assign(club, data);
      return { count: 1 };
    },
  );
});

describe("renameDraftClub", () => {
  it("renames a draft club for its admin, trimmed, and leaves the slug alone", async () => {
    const res = await renameDraftClub("org-friday", "  Friday Football  ");
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-organiser", "org-friday");
    expect(res).toEqual({ ok: true, name: "Friday Football" });
    expect(orgUpdateMany).toHaveBeenCalledTimes(1);
    expect(orgUpdateMany).toHaveBeenCalledWith({
      where: { id: "org-friday", approvalStatus: "draft" },
      data: { name: "Friday Football" },
    });
    expect(club).toMatchObject({ name: "Friday Football", slug: "friday-mt-community" });
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it.each(["pending", "approved", "rejected"])("refuses a %s club and writes nothing", async (status) => {
    club.approvalStatus = status;
    const res = await renameDraftClub("org-friday", "Friday Football");
    expect(res).toMatchObject({ ok: false, reason: "not-draft" });
    expect(club.name).toBe("Friday MT Community");
  });

  it("refuses a non-admin", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(renameDraftClub("org-friday", "Friday Football")).rejects.toThrow("Admin access required");
    expect(orgUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    authMock.mockResolvedValue(null);
    await expect(renameDraftClub("org-friday", "Friday Football")).rejects.toThrow("Not authenticated");
    expect(orgUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["spaces only", "    "],
    ["one character", " A "],
    ["over 60 characters", "x".repeat(61)],
    ["not a string", 42 as unknown as string],
  ])("refuses an invalid name (%s)", async (_label, name) => {
    const res = await renameDraftClub("org-friday", name);
    expect(res).toMatchObject({ ok: false, reason: "invalid" });
    expect(orgUpdateMany).not.toHaveBeenCalled();
    expect(club.name).toBe("Friday MT Community");
  });

  it("accepts the two edges of the length rule (2 and 60 characters)", async () => {
    expect(await renameDraftClub("org-friday", "FC")).toEqual({ ok: true, name: "FC" });
    expect(await renameDraftClub("org-friday", "y".repeat(60))).toEqual({ ok: true, name: "y".repeat(60) });
  });
});
