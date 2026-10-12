/**
 * `goLiveClubAction` and `helloPreviewAction` (go-live slice S4): the gate
 * and who is recorded as having taken the club live. The writer itself is
 * mocked; it is proved against Postgres in e2e/helpers/go-live-lib-tests.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth }));

const requireOrgAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/org", () => ({ requireOrgAdmin }));

const membershipFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { membership: { findFirst: membershipFindFirst } } }));

const goLiveClub = vi.hoisted(() => vi.fn());
const helloPreviewForClub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/club-setup", () => ({
  goLiveClub,
  helloPreviewForClub,
  liveByUser: (id: string) => id,
  liveByOwner: (id: string) => `owner:${id}`,
}));

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

import { goLiveClubAction, helloPreviewAction } from "../club-setup";

const WENT_LIVE = { outcome: "went-live", orgId: "o1", club: "Harbour FC" };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "u-hana" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  membershipFindFirst.mockResolvedValue({ id: "m1" });
  goLiveClub.mockResolvedValue(WENT_LIVE);
  helloPreviewForClub.mockResolvedValue("Hi all");
});

describe("goLiveClubAction", () => {
  it("nobody signed in: refused before anything is read or written", async () => {
    auth.mockResolvedValue(null);
    await expect(goLiveClubAction("o1")).rejects.toThrow("Not authenticated");
    expect(requireOrgAdmin).not.toHaveBeenCalled();
    expect(goLiveClub).not.toHaveBeenCalled();
  });

  it("not an owner or admin of THAT club: refused by the same check every club action uses", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(goLiveClubAction("o1")).rejects.toThrow("Admin access required");
    expect(requireOrgAdmin).toHaveBeenCalledWith("u-hana", "o1");
    expect(goLiveClub).not.toHaveBeenCalled();
  });

  it("the club's own owner or admin: goes live, recorded by user id, and the outcome is returned as it is", async () => {
    expect(await goLiveClubAction("o1")).toBe(WENT_LIVE);
    expect(membershipFindFirst.mock.calls[0][0].where).toEqual({
      userId: "u-hana",
      orgId: "o1",
      leftAt: null,
      role: { in: ["OWNER", "ADMIN"] },
    });
    expect(goLiveClub).toHaveBeenCalledWith("o1", "u-hana");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/settings");
  });

  it("the MatchTime owner acting for a club he is not in: recorded as owner:<id>", async () => {
    auth.mockResolvedValue({ user: { id: "u-kemal" } });
    membershipFindFirst.mockResolvedValue(null);
    await goLiveClubAction("o1");
    expect(goLiveClub).toHaveBeenCalledWith("o1", "owner:u-kemal");
  });

  it("a refusal comes back unchanged, for the page to word", async () => {
    goLiveClub.mockResolvedValue({ outcome: "still-reading", orgId: "o1" });
    expect(await goLiveClubAction("o1")).toEqual({ outcome: "still-reading", orgId: "o1" });
  });
});

describe("helloPreviewAction", () => {
  it("is behind the same gate", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Admin access required"));
    await expect(helloPreviewAction("o1")).rejects.toThrow("Admin access required");
    expect(helloPreviewForClub).not.toHaveBeenCalled();
  });

  it("returns the hello the club would get now", async () => {
    expect(await helloPreviewAction("o1")).toBe("Hi all");
    expect(helloPreviewForClub).toHaveBeenCalledWith("o1");
  });
});
