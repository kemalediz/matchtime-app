/**
 * "@Match Time DM these people" (Vets MNF, 2026-11-09): `inviteNamedPeople`
 * with the database mocked. The same invite as the recruit blast, under the
 * same per-match key, through the BotJob queue; only people MatchTime knows;
 * nobody opted out, already answered or already invited; at most ten.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindFirst = vi.fn();
const userFindMany = vi.fn();
const membershipFindMany = vi.fn();
const sentFindMany = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();
const sessions = vi.fn();
const connects = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findFirst: (...a: unknown[]) => matchFindFirst(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    sentNotification: { findMany: (...a: unknown[]) => sentFindMany(...a), create: (...a: unknown[]) => sentCreate(...a) },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
    onboardingSession: { findMany: (...a: unknown[]) => sessions(...a) },
    clubConnect: { findMany: (...a: unknown[]) => connects(...a) },
  },
}));
vi.mock("@/lib/magic-link", () => ({ signMagicLinkToken: () => "tok", MAGIC_LINK_TTL: { actionNudge: 1 } }));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async () => "https://s/x" }));
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ attendance: true, language: "en" }) }));

import { inviteNamedPeople } from "@/lib/recruit";

const ORG = "org-vets";
const LID_MATT = "201112223334445@lid";

const users = [
  { id: "u-bh", name: "Bilal Hussain", phoneNumber: "+447700900111" },
  { id: "u-matt", name: "Matt Walker", phoneNumber: "+447700900222" },
  { id: "u-stu", name: "Stuart Belcher", phoneNumber: "+447700900333" },
  { id: "u-troy", name: "Troy Dyall", phoneNumber: "+447700900444" },
];

beforeEach(() => {
  vi.clearAllMocks();
  matchFindFirst.mockResolvedValue({
    id: "match-mnf",
    date: new Date("2026-11-09T20:00:00Z"),
    maxPlayers: 14,
    activity: { name: "Monday night vets" },
    attendances: Array.from({ length: 11 }, (_, i) => ({ userId: `in-${i}`, status: "CONFIRMED" })),
  });
  userFindMany.mockResolvedValue(users);
  membershipFindMany.mockResolvedValue([]);
  sentFindMany.mockResolvedValue([]);
  sentCreate.mockResolvedValue({});
  botJobCreate.mockImplementation(async () => ({ id: `job-${botJobCreate.mock.calls.length}` }));
  sessions.mockResolvedValue([]);
  connects.mockResolvedValue([{ userId: "u-matt", dmLid: LID_MATT, participants: null }]);
});

const dmPhones = () => botJobCreate.mock.calls.map((c) => (c[0] as { data: { phone: string; kind: string } }).data.phone);

describe("inviteNamedPeople", () => {
  it("the Vets case: DMs the known people the club's invite, names the unknown numbers, sends nothing to them", async () => {
    const r = await inviteNamedPeople(
      ORG,
      [
        { jid: "158055467598020@lid", phone: "447700900111", name: "BH" },
        { jid: "447747410069@c.us", phone: "447747410069" },
        { jid: LID_MATT, name: "Matt Afc Walcountians Vets" },
        { jid: "999@lid".padStart(20, "1"), name: "Stuart Belcher" },
      ],
      { requesterUserId: "u-kemal" },
    );
    expect(r.kind).toBe("done");
    if (r.kind !== "done") return;
    expect(r.plan.invite.map((p) => p.userId)).toEqual(["u-bh", "u-matt"]);
    expect(r.plan.unknown).toEqual(["+447747410069", "Stuart Belcher"]);
    expect(dmPhones()).toEqual(["447700900111", "447700900222"]);
    for (const c of botJobCreate.mock.calls) {
      const d = (c[0] as { data: { kind: string; text: string; orgId: string } }).data;
      expect(d.kind).toBe("dm");
      expect(d.orgId).toBe(ORG);
      // The club's standard invite: the game, its time, the places, how to answer.
      expect(d.text).toContain("Monday night vets");
      expect(d.text).toContain("3 spots left");
      expect(d.text).toContain("reply *IN*");
    }
    // The recruit blast's own key, per match and person: one invite per game.
    const keys = sentCreate.mock.calls.map((c) => (c[0] as { data: { key: string } }).data.key);
    expect(keys).toEqual(expect.arrayContaining(["match-mnf:recruit-dm:u-bh", "match-mnf:recruit-dm:u-matt"]));
    // Only phones that came from the mention data, and the stored LID's user.
    const where = userFindMany.mock.calls[0][0].where;
    expect(where.OR[0].phoneNumber.in).toEqual(expect.arrayContaining(["+447700900111", "+447747410069"]));
    expect(where.OR[1].id.in).toEqual(["u-matt"]);
  });

  it("opted out or a guest, already answered, already invited for this game, the sender: nobody DM'd", async () => {
    membershipFindMany.mockResolvedValue([{ userId: "u-bh" }]);
    sentFindMany.mockResolvedValue([{ targetUser: "u-stu" }]);
    matchFindFirst.mockResolvedValue({
      id: "match-mnf",
      date: new Date("2026-11-09T20:00:00Z"),
      maxPlayers: 14,
      activity: { name: "Monday night vets" },
      attendances: [{ userId: "u-matt", status: "DROPPED" }],
    });
    const r = await inviteNamedPeople(
      ORG,
      users.map((u) => ({ jid: `${u.phoneNumber.slice(1)}@c.us`, phone: u.phoneNumber.slice(1) })),
      { requesterUserId: "u-troy" },
    );
    expect(botJobCreate).not.toHaveBeenCalled();
    if (r.kind !== "done") throw new Error(r.kind);
    expect(r.plan.optedOut.map((p) => p.userId)).toEqual(["u-bh"]);
    expect(r.plan.answered.map((p) => p.userId)).toEqual(["u-matt"]);
    expect(r.plan.alreadyInvited.map((p) => p.userId)).toEqual(["u-stu"]);
    expect(membershipFindMany.mock.calls[0][0].where).toEqual({
      orgId: ORG,
      userId: { in: ["u-bh", "u-matt", "u-stu", "u-troy"] },
      OR: [{ subMatchInviteDm: false }, { guestMatchId: { not: null } }],
    });
  });

  it("at most ten DMs in one request", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, name: `P${i}`, phoneNumber: `+4477009010${String(i).padStart(2, "0")}` }));
    userFindMany.mockResolvedValue(many);
    const r = await inviteNamedPeople(ORG, many.map((u) => ({ jid: `${u.phoneNumber.slice(1)}@c.us`, phone: u.phoneNumber.slice(1) })), { requesterUserId: null });
    expect(botJobCreate).toHaveBeenCalledTimes(10);
    if (r.kind !== "done") throw new Error(r.kind);
    expect(r.plan.overCap.map((p) => p.userId)).toEqual(["u10", "u11"]);
  });

  it("no place open, or no game: nobody DM'd", async () => {
    matchFindFirst.mockResolvedValueOnce({
      id: "match-mnf",
      date: new Date("2026-11-09T20:00:00Z"),
      maxPlayers: 2,
      activity: { name: "Monday night vets" },
      attendances: [
        { userId: "a", status: "CONFIRMED" },
        { userId: "b", status: "CONFIRMED" },
      ],
    });
    expect(await inviteNamedPeople(ORG, [{ jid: "447700900111@c.us", phone: "447700900111" }], { requesterUserId: null })).toEqual({
      kind: "full",
      matchName: "Monday night vets",
      matchId: "match-mnf",
    });
    matchFindFirst.mockResolvedValueOnce(null);
    expect(await inviteNamedPeople(ORG, [{ jid: "447700900111@c.us", phone: "447700900111" }], { requesterUserId: null })).toEqual({ kind: "no-match" });
    expect(botJobCreate).not.toHaveBeenCalled();
    expect(userFindMany).not.toHaveBeenCalled();
  });
});
