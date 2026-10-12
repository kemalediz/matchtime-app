/**
 * `goLiveClubAction` and `helloPreviewAction` (go-live slice S4): the gate
 * and who is recorded as having taken the club live. The writer itself is
 * mocked; it is proved against Postgres in e2e/helpers/go-live-lib-tests.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth }));

const requireOrgAdmin = vi.hoisted(() => vi.fn());
const isSuperadmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/org", () => ({ requireOrgAdmin, isSuperadmin }));

const learningFlag = vi.hoisted(() => vi.fn());
vi.mock("@/lib/setup-learning-ui-flag", () => ({ setupLearningUiEnabledForRequest: learningFlag }));

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

import { goLiveClubAction, helloPreviewAction, ownerGoLiveNowAction } from "../club-setup";

const WENT_LIVE = { outcome: "went-live", orgId: "o1", club: "Harbour FC" };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "u-hana" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  isSuperadmin.mockResolvedValue(false);
  learningFlag.mockResolvedValue(false);
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
    expect(goLiveClub).toHaveBeenCalledWith("o1", "u-hana", expect.any(Date), { learningEnabled: false });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/settings");
  });

  it("the reading flag is read for this request and handed to the writer, so 'still reading' can block", async () => {
    learningFlag.mockResolvedValue(true);
    await goLiveClubAction("o1");
    expect(goLiveClub).toHaveBeenCalledWith("o1", "u-hana", expect.any(Date), { learningEnabled: true });
  });

  it("S5: the organiser's button can NEVER skip the reading check, whatever extra arguments a caller sends", async () => {
    const smuggle = goLiveClubAction as unknown as (...args: unknown[]) => Promise<unknown>;
    await smuggle("o1", { skipReadingCheck: true }, new Date(), { skipReadingCheck: true });
    // Even the MatchTime owner, through THIS action, keeps the block.
    isSuperadmin.mockResolvedValue(true);
    membershipFindFirst.mockResolvedValue(null);
    await smuggle("o1", { skipReadingCheck: true });
    expect(goLiveClub).toHaveBeenCalledTimes(2);
    for (const call of goLiveClub.mock.calls) {
      expect(call).toHaveLength(4);
      expect(call[3]).toEqual({ learningEnabled: false });
      expect(call[3]).not.toHaveProperty("skipReadingCheck");
    }
  });

  it("the MatchTime owner acting for a club he is not in: recorded as owner:<id>", async () => {
    auth.mockResolvedValue({ user: { id: "u-kemal" } });
    membershipFindFirst.mockResolvedValue(null);
    await goLiveClubAction("o1");
    expect(goLiveClub).toHaveBeenCalledWith("o1", "owner:u-kemal", expect.any(Date), { learningEnabled: false });
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

describe("ownerGoLiveNowAction: the MatchTime owner's Go live now (S5, owner decision 7)", () => {
  const INFO = { orgId: "o1", club: "Harbour FC", group: "Harbour Tuesday 6s", language: "en" };

  beforeEach(() => {
    auth.mockResolvedValue({ user: { id: "u-kemal" } });
    isSuperadmin.mockResolvedValue(true);
    goLiveClub.mockResolvedValue({ ...INFO, outcome: "went-live" });
  });

  it("nobody signed in: refused, nothing written", async () => {
    auth.mockResolvedValue(null);
    await expect(ownerGoLiveNowAction("o1")).rejects.toThrow("Not allowed");
    expect(goLiveClub).not.toHaveBeenCalled();
  });

  it("an owner or admin of the CLUB is not the MatchTime owner: refused, nothing written", async () => {
    auth.mockResolvedValue({ user: { id: "u-hana" } });
    isSuperadmin.mockResolvedValue(false);
    // Even though the club-admin gate would let them through.
    requireOrgAdmin.mockResolvedValue(undefined);
    await expect(ownerGoLiveNowAction("o1")).rejects.toThrow("Not allowed");
    expect(isSuperadmin).toHaveBeenCalledWith("u-hana");
    expect(goLiveClub).not.toHaveBeenCalled();
  });

  it("the MatchTime owner: goes live past an unfinished reading, recorded as owner:<id>", async () => {
    learningFlag.mockResolvedValue(true);
    expect(await ownerGoLiveNowAction("o1")).toEqual({
      ok: true,
      message: 'Harbour FC is live. The hello is on its way to "Harbour Tuesday 6s".',
    });
    expect(goLiveClub).toHaveBeenCalledWith("o1", "owner:u-kemal", expect.any(Date), {
      learningEnabled: true,
      skipReadingCheck: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/clubs");
  });

  it("every refusal is worded, and none of them names a phone number", async () => {
    const said = async (result: unknown) => {
      goLiveClub.mockResolvedValue(result);
      return ownerGoLiveNowAction("o1");
    };
    expect(await said({ ...INFO, outcome: "already-live", liveAt: new Date(), liveBy: "u-hana" })).toEqual({
      ok: false,
      message: "Harbour FC is already live.",
    });
    expect(await said({ ...INFO, outcome: "removed-from-group" })).toEqual({
      ok: false,
      message: 'MatchTime is not in "Harbour Tuesday 6s" any more, so Harbour FC cannot go live.',
    });
    expect(await said({ ...INFO, outcome: "billing-paused" })).toEqual({
      ok: false,
      message: "Harbour FC is paused for the club fee, so it cannot go live yet.",
    });
    expect(await said({ ...INFO, outcome: "still-reading" })).toEqual({
      ok: false,
      message: "Harbour FC is still being read. Try again in a few minutes.",
    });
    expect(await said({ outcome: "not-setting-up", orgId: "o1" })).toEqual({
      ok: false,
      message: "That club is not setting up, so there is nothing to take live.",
    });
  });
});
