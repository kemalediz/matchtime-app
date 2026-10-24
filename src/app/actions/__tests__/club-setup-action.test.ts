/**
 * `goLiveClubAction`, `helloPreviewAction` and `ownerGoLiveNowAction`
 * (go-live slices S4 and S5): the gate, who is recorded as having taken
 * the club live, and what reaches the browser. The writer itself is
 * mocked; it is proved against Postgres in e2e/helpers/go-live-lib-tests.ts,
 * and the gates against real sessions in e2e/web/setup-go-live-authz.spec.ts.
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
const userFindUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  db: { membership: { findFirst: membershipFindFirst }, user: { findUnique: userFindUnique } },
}));

const goLiveClub = vi.hoisted(() => vi.fn());
const helloPreviewForClub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/club-setup", () => ({
  goLiveClub,
  helloPreviewForClub,
  liveByUser: (id: string) => id,
  liveByOwner: (id: string) => `owner:${id}`,
  parseLiveBy: (v: string | null) =>
    !v ? null : v.startsWith("owner:") ? { kind: "matchtime" } : { kind: "user", userId: v },
}));

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const tellOrganiserOwnerWentLive = vi.hoisted(() => vi.fn());
vi.mock("@/lib/club-setup-owner-live", () => ({ tellOrganiserOwnerWentLive }));

import { goLiveClubAction, helloPreviewAction, ownerGoLiveNowAction } from "../club-setup";

const INFO = { orgId: "o1", club: "Harbour FC", group: "Harbour Tuesday 6s", language: "en" };
const WENT_LIVE = {
  ...INFO,
  outcome: "went-live",
  liveAt: new Date(),
  liveBy: "u-hana",
  hello: "Hi all",
  purgedJobs: 3,
  quietedMatches: 1,
  freePeriodStarted: false,
  freePeriodNote: null as string | null,
};
const NOTE = "Your first two months are free.\n\n💷 *Club fee tip:* after that MatchTime only charges for the games you play.";

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "u-hana" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  isSuperadmin.mockResolvedValue(false);
  learningFlag.mockResolvedValue(false);
  membershipFindFirst.mockResolvedValue({ id: "m1" });
  userFindUnique.mockResolvedValue({ name: "Bo Bosun" });
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

  it("its free period started with the go-live: the free period sentence and the club fee tip REACH THE BROWSER, and still no id does", async () => {
    goLiveClub.mockResolvedValue({ ...WENT_LIVE, freePeriodStarted: true, freePeriodNote: NOTE });
    const r = await goLiveClubAction("o1");
    expect(r).toEqual({ outcome: "went-live", club: "Harbour FC", group: "Harbour Tuesday 6s", hello: "Hi all", freePeriodNote: NOTE });
    expect(JSON.stringify(r)).not.toMatch(/u-hana|o1|liveBy|orgId/);
  });

  it("the club's own owner or admin: goes live, recorded by user id; the browser gets what it shows and nothing else", async () => {
    expect(await goLiveClubAction("o1")).toEqual({
      outcome: "went-live",
      club: "Harbour FC",
      group: "Harbour Tuesday 6s",
      hello: "Hi all",
      freePeriodNote: null,
    });
    expect(membershipFindFirst.mock.calls[0][0].where).toEqual({
      userId: "u-hana",
      orgId: "o1",
      leftAt: null,
      role: { in: ["OWNER", "ADMIN"] }, guestMatchId: null,
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

  it("the refusals: only the outcome and the names the page words them with", async () => {
    const said = async (result: unknown) => {
      goLiveClub.mockResolvedValue(result);
      return goLiveClubAction("o1");
    };
    expect(await said({ ...INFO, outcome: "still-reading" })).toEqual({ outcome: "still-reading" });
    expect(await said({ ...INFO, outcome: "removed-from-group" })).toEqual({
      outcome: "removed-from-group",
      club: "Harbour FC",
      group: "Harbour Tuesday 6s",
    });
    expect(await said({ ...INFO, outcome: "billing-paused" })).toEqual({ outcome: "billing-paused", club: "Harbour FC" });
    expect(await said({ outcome: "not-setting-up", orgId: "o1" })).toEqual({ outcome: "not-setting-up" });
  });

  describe("review fix 5: already live never hands a user id to the browser", () => {
    const already = (liveBy: string | null) => ({ ...INFO, outcome: "already-live", liveAt: new Date(), liveBy });

    it("another owner or admin of the club: their NAME, looked up by name only", async () => {
      goLiveClub.mockResolvedValue(already("u-bo"));
      const r = await goLiveClubAction("o1");
      expect(r).toEqual({ outcome: "already-live", club: "Harbour FC", by: "member", byName: "Bo Bosun" });
      expect(userFindUnique).toHaveBeenCalledWith({ where: { id: "u-bo" }, select: { name: true } });
      expect(JSON.stringify(r)).not.toContain("u-bo");
    });

    it("the MatchTime owner: said as MatchTime, and the owner's id is nowhere in the answer", async () => {
      goLiveClub.mockResolvedValue(already("owner:u-kemal"));
      const r = await goLiveClubAction("o1");
      expect(r).toEqual({ outcome: "already-live", club: "Harbour FC", by: "matchtime", byName: null });
      expect(JSON.stringify(r)).not.toContain("u-kemal");
      expect(JSON.stringify(r)).not.toContain("owner:");
      expect(userFindUnique).not.toHaveBeenCalled();
    });

    it("review fix 4: the caller themselves (a lost answer, then a retry): 'you', so the page says it worked", async () => {
      goLiveClub.mockResolvedValue(already("u-hana"));
      const r = await goLiveClubAction("o1");
      expect(r).toEqual({ outcome: "already-live", club: "Harbour FC", by: "you", byName: null });
      expect(userFindUnique).not.toHaveBeenCalled();
      expect(JSON.stringify(r)).not.toContain("u-hana");
    });

    it("nobody recorded, or a person with no name: unknown, and still no id", async () => {
      goLiveClub.mockResolvedValue(already(null));
      expect(await goLiveClubAction("o1")).toEqual({ outcome: "already-live", club: "Harbour FC", by: "unknown", byName: null });
      goLiveClub.mockResolvedValue(already("u-bo"));
      userFindUnique.mockResolvedValue({ name: "  " });
      expect(await goLiveClubAction("o1")).toEqual({ outcome: "already-live", club: "Harbour FC", by: "unknown", byName: null });
    });
  });

  it("review fix 5: no outcome carries the club's id, a user id, or the writer's bookkeeping", async () => {
    for (const result of [
      WENT_LIVE,
      { ...INFO, outcome: "already-live", liveAt: new Date(), liveBy: "owner:u-kemal" },
      { ...INFO, outcome: "still-reading" },
      { ...INFO, outcome: "removed-from-group" },
      { ...INFO, outcome: "billing-paused" },
      { outcome: "not-setting-up", orgId: "o1" },
    ]) {
      goLiveClub.mockResolvedValue(result);
      const r = (await goLiveClubAction("o1")) as Record<string, unknown>;
      for (const key of ["orgId", "liveBy", "liveAt", "purgedJobs", "quietedMatches", "language"]) {
        expect(r, `${result.outcome}.${key}`).not.toHaveProperty(key);
      }
    }
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
  beforeEach(() => {
    auth.mockResolvedValue({ user: { id: "u-kemal" } });
    isSuperadmin.mockResolvedValue(true);
    tellOrganiserOwnerWentLive.mockReset();
    tellOrganiserOwnerWentLive.mockResolvedValue("queued");
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
      message:
        'Harbour FC is live. The hello is on its way to "Harbour Tuesday 6s". No free period started. The organiser is being told by WhatsApp.',
    });
    // And when its free period did start with it, the owner is told so.
    goLiveClub.mockResolvedValue({ ...WENT_LIVE, freePeriodStarted: true, freePeriodNote: NOTE });
    expect(await ownerGoLiveNowAction("o1")).toEqual({
      ok: true,
      message:
        'Harbour FC is live. The hello is on its way to "Harbour Tuesday 6s". Its free period started now. The organiser is being told by WhatsApp.',
    });
    expect(goLiveClub).toHaveBeenCalledWith("o1", "owner:u-kemal", expect.any(Date), {
      learningEnabled: true,
      skipReadingCheck: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/clubs");
  });

  // Item 1. The organiser did not say GO, so nothing else tells them: the
  // hello appears, the free period starts, a waiting setup DM is cancelled.
  it("THE ORGANISER IS TOLD: after a go-live this call made, the writer's own result (free period note included) goes to the DM, once", async () => {
    const live = { ...WENT_LIVE, freePeriodStarted: true, freePeriodNote: NOTE };
    goLiveClub.mockResolvedValue(live);
    await ownerGoLiveNowAction("o1");
    expect(tellOrganiserOwnerWentLive).toHaveBeenCalledTimes(1);
    // The very object `goLiveClub` returned: the note is reused, not rebuilt.
    expect(tellOrganiserOwnerWentLive.mock.calls[0][0]).toBe(live);
  });

  it("nobody is told when this call did not take the club live (already live, removed, paused, not setting up)", async () => {
    for (const refusal of [
      { outcome: "already-live", orgId: "o1", club: "Harbour FC", group: "G", language: "en", liveAt: new Date(), liveBy: "u" },
      { outcome: "removed-from-group", orgId: "o1", club: "Harbour FC", group: "G", language: "en" },
      { outcome: "billing-paused", orgId: "o1", club: "Harbour FC", group: "G", language: "en" },
      { outcome: "not-setting-up", orgId: "o1" },
    ]) {
      goLiveClub.mockResolvedValue(refusal);
      await ownerGoLiveNowAction("o1");
    }
    expect(tellOrganiserOwnerWentLive).not.toHaveBeenCalled();
  });

  it("the owner sees what became of that DM, in every case, and the club is live whatever it was", async () => {
    const said = async (told: string) => {
      tellOrganiserOwnerWentLive.mockResolvedValue(told);
      return (await ownerGoLiveNowAction("o1")).message;
    };
    expect(await said("already")).toMatch(/The organiser has already been told\.$/);
    expect(await said("no-organiser")).toMatch(/There is no organiser on record, so nobody was told\.$/);
    expect(await said("refused")).toMatch(/The organiser could NOT be told: their number was refused\.$/);
    expect(await said("failed")).toMatch(/The organiser could NOT be told: the message was not queued\.$/);
    for (const message of [await said("refused"), await said("failed")]) expect(message).toMatch(/^Harbour FC is live\./);
  });

  it("the organiser's own Go live button tells nobody by DM: they pressed it themselves", async () => {
    auth.mockResolvedValue({ user: { id: "u-hana" } });
    await goLiveClubAction("o1");
    expect(tellOrganiserOwnerWentLive).not.toHaveBeenCalled();
  });

  // Second walk, item 2. The MatchTime owner can also press the club's OWN
  // Go live button on its settings page. That go-live was recorded as the
  // owner's, and the organiser was told nothing: only "Go live now" told them.
  it("the MatchTime owner pressing the CLUB'S OWN button (not an owner or admin of it): the organiser is told, once, with the writer's own result", async () => {
    auth.mockResolvedValue({ user: { id: "u-kemal" } });
    membershipFindFirst.mockResolvedValue(null);
    const live = { ...WENT_LIVE, freePeriodStarted: true, freePeriodNote: NOTE };
    goLiveClub.mockResolvedValue(live);
    const out = await goLiveClubAction("o1");
    expect(goLiveClub.mock.calls[0][1]).toBe("owner:u-kemal");
    expect(tellOrganiserOwnerWentLive).toHaveBeenCalledTimes(1);
    expect(tellOrganiserOwnerWentLive.mock.calls[0][0]).toBe(live);
    // The button's own answer is what it always was.
    expect(out).toMatchObject({ outcome: "went-live", club: "Harbour FC" });
  });

  it("through that door too, nobody is told when the press did not take the club live", async () => {
    auth.mockResolvedValue({ user: { id: "u-kemal" } });
    membershipFindFirst.mockResolvedValue(null);
    for (const refusal of [
      { outcome: "already-live", orgId: "o1", club: "Harbour FC", group: "G", language: "en", liveAt: new Date(), liveBy: "u" },
      { outcome: "still-reading", orgId: "o1", club: "Harbour FC", group: "G", language: "en" },
      { outcome: "removed-from-group", orgId: "o1", club: "Harbour FC", group: "G", language: "en" },
      { outcome: "billing-paused", orgId: "o1", club: "Harbour FC", group: "G", language: "en" },
      { outcome: "not-setting-up", orgId: "o1" },
    ]) {
      goLiveClub.mockResolvedValue(refusal);
      await goLiveClubAction("o1");
    }
    expect(tellOrganiserOwnerWentLive).not.toHaveBeenCalled();
  });

  it("a superadmin who IS an owner or admin of the club pressed their own button: recorded as themselves, nobody is DMed", async () => {
    auth.mockResolvedValue({ user: { id: "u-kemal" } });
    membershipFindFirst.mockResolvedValue({ id: "m-kemal" });
    await goLiveClubAction("o1");
    expect(goLiveClub.mock.calls[0][1]).toBe("u-kemal");
    expect(tellOrganiserOwnerWentLive).not.toHaveBeenCalled();
  });

  it("every refusal is worded, and none of them names a phone number or an id", async () => {
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
