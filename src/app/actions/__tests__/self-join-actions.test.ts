/**
 * Self-join slice 4: the server actions behind the organiser web.
 *
 *   - flag OFF: `createOrganisation` is today's, byte for byte (no draft,
 *     no weekly game), and the new actions refuse;
 *   - flag ON: the two OLD creation paths (`createOrganisation`, the
 *     /onboarding wizard) refuse, so neither can make an approved club
 *     around the caps, and `createSelfJoinClubAction` answers in the
 *     organiser's language;
 *   - `startClubConnect` is for the club's OWNER only, and hands back the
 *     wa.me link with the server-only number and the prefilled text.
 *
 * db, auth, the flag and next/* are mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const flag = vi.fn();
const setCurrentOrgId = vi.fn();
const isSuperadmin = vi.fn();
const createSelfJoinClub = vi.fn();
const issueConnectCode = vi.fn();
const matchtimeWaNumber = vi.fn();

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn(), create: vi.fn() },
  membership: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/self-join-flag", () => ({ selfJoinEnabledForRequest: () => flag() }));
vi.mock("@/lib/org", () => ({
  setCurrentOrgId: (...a: unknown[]) => setCurrentOrgId(...a),
  isSuperadmin: (...a: unknown[]) => isSuperadmin(...a),
}));
vi.mock("@/lib/self-join-club", () => ({ createSelfJoinClub: (...a: unknown[]) => createSelfJoinClub(...a) }));
vi.mock("@/lib/club-connect", () => ({
  issueConnectCode: (...a: unknown[]) => issueConnectCode(...a),
  matchtimeWaNumber: () => matchtimeWaNumber(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { createOrganisation, createSelfJoinClubAction } from "../org";
import { startClubConnect } from "../club-connect";
import { createOrgFromWizard } from "../onboarding";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u1" } });
  isSuperadmin.mockResolvedValue(false);
  flag.mockResolvedValue(false);
  dbMock.organisation.findUnique.mockResolvedValue(null);
  dbMock.organisation.create.mockResolvedValue({ id: "org-legacy", slug: "sunday-league-fc" });
  matchtimeWaNumber.mockReturnValue("447700900777");
});

describe("flag OFF: today's behaviour", () => {
  it("createOrganisation creates the club exactly as before", async () => {
    const res = await createOrganisation({ name: "Sunday League FC", slug: "sunday-league-fc" });
    expect(res).toEqual({ orgId: "org-legacy", slug: "sunday-league-fc" });
    expect(dbMock.organisation.create).toHaveBeenCalledWith({
      data: {
        name: "Sunday League FC",
        slug: "sunday-league-fc",
        memberships: { create: { userId: "u1", role: "OWNER" } },
      },
    });
    expect(createSelfJoinClub).not.toHaveBeenCalled();
  });

  it("the self-join actions refuse", async () => {
    expect(await createSelfJoinClubAction({ name: "Riverside FC", language: "en", game: null })).toMatchObject({
      ok: false,
    });
    expect(await startClubConnect("org-1")).toMatchObject({ ok: false });
    expect(createSelfJoinClub).not.toHaveBeenCalled();
    expect(issueConnectCode).not.toHaveBeenCalled();
  });
});

describe("flag ON: club creation goes through the self-join path only", () => {
  beforeEach(() => flag.mockResolvedValue(true));

  it("createOrganisation (the old form) refuses", async () => {
    await expect(createOrganisation({ name: "Sunday League FC", slug: "sunday-league-fc" })).rejects.toThrow();
    expect(dbMock.organisation.create).not.toHaveBeenCalled();
  });

  it("the /onboarding wizard refuses (it would make an approved club, and it calls a model)", async () => {
    await expect(
      createOrgFromWizard({
        orgName: "Riverside FC",
        players: [{ name: "Ali" }],
        activity: { sportKey: "football-7aside", name: "", dayOfWeek: 2, time: "21:30", venue: "x", matchDurationMins: 60 },
      } as never),
    ).rejects.toThrow();
  });

  it("createSelfJoinClubAction creates the draft and makes it the current club", async () => {
    createSelfJoinClub.mockResolvedValue({ ok: true, orgId: "org-new", slug: "riverside-fc" });
    const input = {
      name: "Riverside FC",
      language: "tr",
      game: { dayOfWeek: 2, time: "21:30", venue: "Goals Wembley", playersPerSide: 7 },
    };
    expect(await createSelfJoinClubAction(input)).toEqual({ ok: true, orgId: "org-new" });
    expect(createSelfJoinClub).toHaveBeenCalledWith("u1", input, expect.any(Date));
    expect(setCurrentOrgId).toHaveBeenCalledWith("org-new");
  });

  it("refusals come back as friendly text in the organiser's language", async () => {
    createSelfJoinClub.mockResolvedValue({ ok: false, reason: "one-club" });
    expect(await createSelfJoinClubAction({ name: "x", language: "en", game: null })).toEqual({
      ok: false,
      reason: "one-club",
      error: "You already have a club on MatchTime. Open it from your profile.",
    });
    expect(await createSelfJoinClubAction({ name: "x", language: "tr", game: null })).toEqual({
      ok: false,
      reason: "one-club",
      error: "MatchTime'da zaten bir kulübünüz var. Profilinizden açabilirsiniz.",
    });
    createSelfJoinClub.mockResolvedValue({ ok: false, reason: "site-cap" });
    expect(await createSelfJoinClubAction({ name: "x", language: "en", game: null })).toMatchObject({
      error: "We're taking on a few new clubs each day. Please try again tomorrow.",
    });
  });

  it("signed out: refused", async () => {
    authMock.mockResolvedValue(null);
    expect(await createSelfJoinClubAction({ name: "x", language: "en", game: null })).toMatchObject({ ok: false });
    expect(createSelfJoinClub).not.toHaveBeenCalled();
  });
});

describe("startClubConnect: the button", () => {
  beforeEach(() => {
    flag.mockResolvedValue(true);
    dbMock.membership.findUnique.mockResolvedValue({ role: "OWNER", leftAt: null });
    dbMock.organisation.findUnique.mockResolvedValue({ id: "org-1", name: "Riverside FC", language: "tr" });
    dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900123" });
    issueConnectCode.mockResolvedValue({ ok: true, code: "7KQ2", reused: false });
  });

  it("issues a code and returns the wa.me link with the number and the prefilled text", async () => {
    expect(await startClubConnect("org-1")).toEqual({
      ok: true,
      href: "https://wa.me/447700900777?text=Riverside%20FC%20kul%C3%BCb%C3%BCn%C3%BC%20ba%C4%9Fla%2C%20kod%207KQ2",
      code: "7KQ2",
    });
    expect(issueConnectCode).toHaveBeenCalledWith({
      orgId: "org-1",
      userId: "u1",
      phone: "+447700900123",
      now: expect.any(Date),
    });
  });

  it("the OWNER only: an admin, a player or a stranger gets nothing", async () => {
    for (const m of [{ role: "ADMIN", leftAt: null }, { role: "PLAYER", leftAt: null }, { role: "OWNER", leftAt: new Date() }, null]) {
      dbMock.membership.findUnique.mockResolvedValue(m);
      expect(await startClubConnect("org-1")).toMatchObject({ ok: false });
    }
    expect(issueConnectCode).not.toHaveBeenCalled();
  });

  it("no number configured: no code is spent", async () => {
    matchtimeWaNumber.mockReturnValue(null);
    expect(await startClubConnect("org-1")).toMatchObject({ ok: false, reason: "no-number" });
    expect(issueConnectCode).not.toHaveBeenCalled();
  });

  it("a refused code comes back in the club's language", async () => {
    issueConnectCode.mockResolvedValue({ ok: false, reason: "code-cap" });
    expect(await startClubConnect("org-1")).toEqual({
      ok: false,
      reason: "code-cap",
      error: "Bugünkü kodlarınızı kullandınız. Lütfen yarın tekrar deneyin.",
    });
  });
});
