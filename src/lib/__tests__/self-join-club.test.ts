/**
 * Self-join slice 4: creating a club on the website (plan section 5.1,
 * decision 2, caps 1 and 4 of section 7).
 *
 *   - a new club starts in DRAFT, with the language the organiser picked
 *     and the weekly game (day, time, venue, players per side) already
 *     set up, so the approval hello can land on a group with a match;
 *   - one club per verified phone (superadmins exempt);
 *   - 10 new self-join clubs a day across the site (superadmins exempt);
 *   - the phone must have been verified by a WhatsApp code.
 *
 * db is mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const txOrgCreate = vi.fn();
const txSportCreate = vi.fn();
const txActivityCreate = vi.fn();
const dbMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  phoneOtp: { count: vi.fn() },
  membership: { count: vi.fn() },
  organisation: { count: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: {
    ...dbMock,
    $transaction: (fn: (t: unknown) => unknown) =>
      fn({
        organisation: { create: (...a: unknown[]) => txOrgCreate(...a) },
        sport: { create: (...a: unknown[]) => txSportCreate(...a) },
        activity: { create: (...a: unknown[]) => txActivityCreate(...a) },
      }),
  },
}));

import { createSelfJoinClub } from "../self-join-club";
import { SELF_JOIN_CLUB_WHERE } from "../club-approval";

const NOW = new Date("2026-09-29T12:00:00Z");
const INPUT = {
  name: "Riverside FC",
  language: "tr",
  game: { dayOfWeek: 2, time: "21:30", venue: "Goals Wembley", playersPerSide: 7 },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.user.findUnique.mockResolvedValue({ id: "u1", phoneNumber: "+447700900123", isSuperadmin: false });
  dbMock.phoneOtp.count.mockResolvedValue(1);
  dbMock.membership.count.mockResolvedValue(0);
  dbMock.organisation.count.mockResolvedValue(0);
  dbMock.organisation.findUnique.mockResolvedValue(null);
  txOrgCreate.mockImplementation(async ({ data }: { data: { slug: string } }) => ({ id: "org-new", slug: data.slug }));
  txSportCreate.mockResolvedValue({ id: "sport-new" });
  txActivityCreate.mockResolvedValue({ id: "act-new" });
});

describe("createSelfJoinClub", () => {
  it("creates a DRAFT club with the organiser as OWNER, in the language they picked", async () => {
    const res = await createSelfJoinClub("u1", INPUT, NOW);
    expect(res).toEqual({ ok: true, orgId: "org-new", slug: "riverside-fc" });
    const data = txOrgCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: "Riverside FC",
      slug: "riverside-fc",
      language: "tr",
      memberships: { create: { userId: "u1", role: "OWNER" } },
    });
    // The draft state comes from club-approval's one writer, and the bot stays off.
    expect(data.approvalStatus).toBe("draft");
    expect(data.whatsappBotEnabled).toBeUndefined();
    expect(data.whatsappGroupId).toBeUndefined();
  });

  it("sets up the weekly game: a sport for the size and an activity on the day, time and venue", async () => {
    await createSelfJoinClub("u1", INPUT, NOW);
    expect(txSportCreate.mock.calls[0][0].data).toMatchObject({
      orgId: "org-new",
      preset: "football-7aside",
      playersPerTeam: 7,
    });
    expect(txActivityCreate.mock.calls[0][0].data).toMatchObject({
      orgId: "org-new",
      sportId: "sport-new",
      dayOfWeek: 2,
      time: "21:30",
      venue: "Goals Wembley",
      name: "7'ye 7 futbol",
    });
  });

  it("names the activity in English for an English club", async () => {
    await createSelfJoinClub("u1", { ...INPUT, language: "en", game: { ...INPUT.game, playersPerSide: 6 } }, NOW);
    expect(txActivityCreate.mock.calls[0][0].data.name).toBe("Football 6-a-side");
    expect(txSportCreate.mock.calls[0][0].data).toMatchObject({ preset: null, playersPerTeam: 6 });
  });

  it("refuses bad input without writing", async () => {
    for (const bad of [
      { ...INPUT, name: " " },
      { ...INPUT, name: "x".repeat(61) },
      { ...INPUT, language: "de" },
      { ...INPUT, game: { ...INPUT.game, time: "25:00" } },
      { ...INPUT, game: { ...INPUT.game, venue: "" } },
    ]) {
      expect(await createSelfJoinClub("u1", bad, NOW)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(txOrgCreate).not.toHaveBeenCalled();
  });

  it("needs a phone verified by a WhatsApp code", async () => {
    dbMock.phoneOtp.count.mockResolvedValue(0);
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toEqual({ ok: false, reason: "verify-phone" });
    expect(dbMock.phoneOtp.count).toHaveBeenCalledWith({
      where: { phone: "447700900123", usedAt: { not: null } },
    });
    dbMock.user.findUnique.mockResolvedValue({ id: "u1", phoneNumber: null, isSuperadmin: false });
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toEqual({ ok: false, reason: "verify-phone" });
    expect(txOrgCreate).not.toHaveBeenCalled();
  });

  it("one club per verified phone: any self-join club this person owns blocks a second", async () => {
    dbMock.membership.count.mockResolvedValue(1);
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toEqual({ ok: false, reason: "one-club" });
    expect(dbMock.membership.count).toHaveBeenCalledWith({
      where: { userId: "u1", role: "OWNER", org: SELF_JOIN_CLUB_WHERE },
    });
    expect(txOrgCreate).not.toHaveBeenCalled();
  });

  it("10 new self-join clubs a day across the site", async () => {
    dbMock.organisation.count.mockResolvedValue(10);
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toEqual({ ok: false, reason: "site-cap" });
    expect(dbMock.organisation.count).toHaveBeenCalledWith({
      where: { ...SELF_JOIN_CLUB_WHERE, createdAt: { gte: new Date("2026-09-28T23:00:00.000Z") } },
    });
    dbMock.organisation.count.mockResolvedValue(9);
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toMatchObject({ ok: true });
  });

  it("superadmins are exempt from the phone check and both caps", async () => {
    dbMock.user.findUnique.mockResolvedValue({ id: "u1", phoneNumber: null, isSuperadmin: true });
    dbMock.phoneOtp.count.mockResolvedValue(0);
    dbMock.membership.count.mockResolvedValue(3);
    dbMock.organisation.count.mockResolvedValue(50);
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toMatchObject({ ok: true });
  });

  it("a taken slug gets a number on the end rather than an error", async () => {
    dbMock.organisation.findUnique.mockImplementation(async ({ where }: { where: { slug: string } }) =>
      where.slug === "riverside-fc" ? { id: "other" } : null,
    );
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toEqual({ ok: true, orgId: "org-new", slug: "riverside-fc-2" });
  });

  it("an unknown user is refused", async () => {
    dbMock.user.findUnique.mockResolvedValue(null);
    expect(await createSelfJoinClub("u1", INPUT, NOW)).toEqual({ ok: false, reason: "verify-phone" });
  });
});

describe("SELF_JOIN_CLUB_WHERE: which clubs came through self-join", () => {
  it("any club not approved, or approved through the flow (approvedAt set); never an existing club", () => {
    expect(SELF_JOIN_CLUB_WHERE).toEqual({
      OR: [{ approvalStatus: { not: "approved" } }, { approvedAt: { not: null } }],
    });
  });
});
