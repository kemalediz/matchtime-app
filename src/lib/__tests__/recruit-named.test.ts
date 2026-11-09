/**
 * "@Match Time DM these people" (Vets MNF, 2026-11-09): `inviteNamedPeople`
 * with the database mocked. The same invite as the recruit blast, under the
 * same per-match key, through the BotJob queue; only people MatchTime knows;
 * nobody opted out (in any club), gone from this club, already answered or
 * already invited; at most ten; the marker claimed before the DM is queued.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const matchFindFirst = vi.fn();
const userFindMany = vi.fn();
const membershipFindMany = vi.fn();
const sentFindMany = vi.fn();
const sentCreate = vi.fn();
const sentDelete = vi.fn();
const botJobCreate = vi.fn();
const sessions = vi.fn();
const connects = vi.fn();
const orgFindUnique = vi.fn();
const connectFindFirst = vi.fn();
const venueAndFee = vi.fn();
const order: string[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    match: { findFirst: (...a: unknown[]) => matchFindFirst(...a) },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    sentNotification: {
      findMany: (...a: unknown[]) => sentFindMany(...a),
      create: (...a: unknown[]) => sentCreate(...a),
      delete: (...a: unknown[]) => sentDelete(...a),
    },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
    onboardingSession: { findMany: (...a: unknown[]) => sessions(...a) },
    clubConnect: { findMany: (...a: unknown[]) => connects(...a), findFirst: (...a: unknown[]) => connectFindFirst(...a) },
    organisation: { findUnique: (...a: unknown[]) => orgFindUnique(...a) },
  },
}));
vi.mock("@/lib/pool/offer-facts", () => ({ loadMatchVenueAndFee: (...a: unknown[]) => venueAndFee(...a) }));
vi.mock("@/lib/magic-link", () => ({ signMagicLinkToken: () => "tok", MAGIC_LINK_TTL: { actionNudge: 1 } }));
const shortLink = vi.fn(async () => "https://s/x");
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: () => shortLink() }));
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ attendance: true, language: "en" }) }));

import { inviteNamedPeople } from "@/lib/recruit";

const ORG = "org-vets";
const NOW = new Date("2026-11-09T17:30:00Z");
const LID_MATT = "201112223334445@lid";

const users = [
  { id: "u-bh", name: "Bilal Hussain", phoneNumber: "+447700900111" },
  { id: "u-matt", name: "Matt W (global name)", phoneNumber: "+447700900222" },
  { id: "u-stu", name: "Stuart Belcher", phoneNumber: "+447700900333" },
  { id: "u-troy", name: "Troy Dyall", phoneNumber: "+447700900444" },
];
/** A current membership of this club. */
const member = (userId: string, over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  userId,
  subMatchInviteDm: true,
  leftAt: null,
  removedByOrganiserAt: null,
  guestMatchId: null,
  ...over,
});
const tags = (mentions: Array<{ jid: string; phone?: string; name?: string }>, unidentified = 0) => ({ mentions, unidentified });
const byPhone = (u: (typeof users)[number], name?: string) => ({ jid: `${u.phoneNumber.slice(1)}@c.us`, phone: u.phoneNumber.slice(1), ...(name ? { name } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  matchFindFirst.mockResolvedValue({
    id: "match-mnf",
    date: new Date("2026-11-09T20:00:00Z"),
    maxPlayers: 14,
    activity: { name: "Monday night vets" },
    attendances: Array.from({ length: 11 }, (_, i) => ({ userId: `in-${i}`, status: "CONFIRMED" })),
  });
  userFindMany.mockResolvedValue(users);
  membershipFindMany.mockResolvedValue(users.map((u) => member(u.id)));
  sentFindMany.mockResolvedValue([]);
  sentCreate.mockImplementation(async (a: { data: { kind: string; key: string } }) => {
    order.push(`marker:${a.data.kind}`);
    return {};
  });
  sentDelete.mockResolvedValue({});
  botJobCreate.mockImplementation(async () => {
    order.push("job");
    return { id: `job-${botJobCreate.mock.calls.length}` };
  });
  sessions.mockResolvedValue([]);
  connects.mockResolvedValue([{ userId: "u-matt", dmLid: LID_MATT, participants: null }]);
  orgFindUnique.mockResolvedValue({ whatsappGroupId: "vets@g.us" });
  connectFindFirst.mockResolvedValue({ groupSubject: "Vets MNF" });
  venueAndFee.mockResolvedValue({ club: "Monday night vets", venueName: "Oaks Park High School football field", fee: { kind: "amount", amount: "£8" } });
});

const dmPhones = () => botJobCreate.mock.calls.map((c) => (c[0] as { data: { phone: string } }).data.phone);
const dmTexts = () => botJobCreate.mock.calls.map((c) => (c[0] as { data: { text: string } }).data.text);

describe("inviteNamedPeople", () => {
  it("the Vets case: DMs the known people the club's invite, names the unknown numbers, sends nothing to them", async () => {
    const r = await inviteNamedPeople(
      ORG,
      tags([
        { jid: "158055467598020@lid", phone: "447700900111", name: "BH" },
        { jid: "447747410069@c.us", phone: "447747410069" },
        { jid: LID_MATT, name: "Matt Afc Walcountians Vets" },
        { jid: "11111111111111999@lid", name: "Stuart Belcher" },
      ]),
      { requesterUserId: "u-kemal", now: NOW },
    );
    if (r.kind !== "done") throw new Error(r.kind);
    expect(r.plan.invite.map((p) => p.userId)).toEqual(["u-bh", "u-matt"]);
    expect(r.plan.unknown).toEqual(["+447747410069", "Stuart Belcher"]);
    expect(dmPhones()).toEqual(["447700900111", "447700900222"]);
    for (const text of dmTexts()) {
      expect(text).toContain("Monday night vets");
      expect(text).toContain("3 spots left");
      expect(text).toContain("reply *IN*");
    }
    const keys = sentCreate.mock.calls.map((c) => (c[0] as { data: { key: string } }).data.key);
    expect(keys).toEqual(expect.arrayContaining(["match-mnf:recruit-dm:u-bh", "match-mnf:recruit-dm:u-matt"]));
  });

  it("the DM greets by the tag's WhatsApp name and names the club, the players' group, the venue and the fee (Kemal, 2026-11-09)", async () => {
    // The club stored Matt as "UTV"; his WhatsApp name is still the greeting.
    userFindMany.mockResolvedValue(users.map((u) => (u.id === "u-matt" ? { ...u, name: "UTV" } : u)));
    await inviteNamedPeople(
      ORG,
      tags([
        { jid: "158055467598020@lid", phone: "447700900111", name: "BH" },
        { jid: LID_MATT, name: "Matt Afc Walcountians Vets" },
      ]),
      { requesterUserId: null, now: NOW },
    );
    const [bh, matt] = dmTexts();
    expect(bh.split("\n").slice(0, 5)).toEqual([
      "👋 BH, it's *Monday night vets* here, from the Vets MNF group.",
      "",
      "We're putting the squad together for *Monday night vets* on Mon 9 Nov, 20:00. 3 spots left.",
      "📍 Oaks Park High School football field",
      "💷 £8 a game",
    ]);
    expect(bh.endsWith("Don't want messages like this? Reply *STOP*.")).toBe(true);
    // Matt's WhatsApp name wins over the name MatchTime stored for him.
    expect(matt.split("\n")[0]).toBe("👋 Matt, it's *Monday night vets* here, from the Vets MNF group.");
    // The players' group of THIS club, whatever group the request came from.
    expect(connectFindFirst.mock.calls[0][0]).toMatchObject({ where: { orgId: ORG, groupId: "vets@g.us" } });
    // Loaded once per request, not once per person.
    expect(venueAndFee).toHaveBeenCalledTimes(1);
    expect(venueAndFee).toHaveBeenCalledWith("match-mnf");
  });

  it("a tag with no WhatsApp name: the club's stored name; details that fail to load: the invite still goes, without them", async () => {
    venueAndFee.mockRejectedValue(new Error("db down"));
    await inviteNamedPeople(ORG, tags([{ jid: "158055467598020@lid", phone: "447700900111" }]), { requesterUserId: null, now: NOW });
    expect(dmTexts()).toHaveLength(1);
    expect(dmTexts()[0].split("\n")[0]).toBe("👋 Bilal, we're putting the squad together for *Monday night vets* on Mon 9 Nov, 20:00. 3 spots left.");
  });

  it("named in the reply by this club's name for a member, never User.name (review #2)", async () => {
    const r = await inviteNamedPeople(ORG, tags([{ jid: LID_MATT, name: "Matt Afc" }]), { requesterUserId: null, now: NOW });
    if (r.kind !== "done") throw new Error(r.kind);
    expect(r.plan.invite[0]).toMatchObject({ userId: "u-matt", label: "Matt W (global name)", member: true });
  });

  it("someone MatchTime knows with no membership here: DM'd the group-style invite (the app link would refuse him), named by his WhatsApp name (review #2)", async () => {
    membershipFindMany.mockResolvedValue([member("u-bh"), member("u-stu", { orgId: "other-club" })]);
    const r = await inviteNamedPeople(ORG, tags([byPhone(users[2], "Stu B")]), { requesterUserId: null, now: NOW });
    if (r.kind !== "done") throw new Error(r.kind);
    expect(r.plan.invite[0]).toMatchObject({ userId: "u-stu", label: "Stu B", member: false });
    expect(dmTexts()[0]).toContain("reply *IN* in the group");
    expect(dmTexts()[0]).not.toContain("https://");
  });

  it("opted out in ANY club, a guest here, left here, removed by this club's organisers: nobody DM'd (review #2)", async () => {
    membershipFindMany.mockResolvedValue([
      member("u-bh"),
      { ...member("u-bh"), orgId: "other-club", subMatchInviteDm: false },
      member("u-matt", { guestMatchId: "m-old" }),
      member("u-stu", { leftAt: new Date("2026-10-01") }),
      member("u-troy", { removedByOrganiserAt: new Date("2026-10-02") }),
    ]);
    const r = await inviteNamedPeople(ORG, tags(users.map((u) => byPhone(u))), { requesterUserId: null, now: NOW });
    if (r.kind !== "done") throw new Error(r.kind);
    expect(botJobCreate).not.toHaveBeenCalled();
    expect(r.plan.optedOut.map((p) => p.userId)).toEqual(["u-bh", "u-matt"]);
    expect(r.plan.notHere.map((p) => p.userId)).toEqual(["u-stu", "u-troy"]);
    // Every club's memberships of these people are read, not only this one's.
    expect(membershipFindMany.mock.calls[0][0].where).toEqual({ userId: { in: ["u-bh", "u-matt", "u-stu", "u-troy"] } });
  });

  it("already answered, already invited for this game, the sender: nobody DM'd", async () => {
    sentFindMany.mockResolvedValue([{ targetUser: "u-stu" }]);
    matchFindFirst.mockResolvedValue({
      id: "match-mnf",
      date: new Date("2026-11-09T20:00:00Z"),
      maxPlayers: 14,
      activity: { name: "Monday night vets" },
      attendances: [{ userId: "u-matt", status: "DROPPED" }],
    });
    const r = await inviteNamedPeople(ORG, tags(users.map((u) => byPhone(u))), { requesterUserId: "u-troy", now: NOW });
    if (r.kind !== "done") throw new Error(r.kind);
    expect(dmPhones()).toEqual(["447700900111"]);
    expect(r.plan.answered.map((p) => p.userId)).toEqual(["u-matt"]);
    expect(r.plan.alreadyInvited.map((p) => p.userId)).toEqual(["u-stu"]);
  });

  it("the marker is claimed BEFORE the DM is queued; losing the claim to a concurrent request skips that person, never a second DM or a throw (review #3)", async () => {
    sentCreate.mockImplementation(async (a: { data: { kind: string; targetUser: string } }) => {
      if (a.data.kind === "recruit-dm" && a.data.targetUser === "u-matt") throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      order.push(`marker:${a.data.kind}`);
      return {};
    });
    const r = await inviteNamedPeople(ORG, tags([byPhone(users[0]), byPhone(users[1])]), { requesterUserId: null, now: NOW });
    if (r.kind !== "done") throw new Error(r.kind);
    expect(order.slice(0, 2)).toEqual(["marker:recruit-dm", "job"]);
    // The lost claim made nothing: no short link, no DM.
    expect(shortLink).toHaveBeenCalledTimes(1);
    expect(dmPhones()).toEqual(["447700900111"]);
    expect(r.plan.invite.map((p) => p.userId)).toEqual(["u-bh"]);
    expect(r.plan.alreadyInvited.map((p) => p.userId)).toEqual(["u-matt"]);
    // The marker and the job share one time, so the chase's "DM'd since the
    // invite" test never counts the invite itself.
    const markerAt = (sentCreate.mock.calls[0][0] as { data: { createdAt: Date } }).data.createdAt;
    const jobAt = (botJobCreate.mock.calls[0][0] as { data: { createdAt: Date } }).data.createdAt;
    expect(markerAt).toEqual(jobAt);
  });

  it("a DM that cannot be queued gives its marker back, so a later ask can try again", async () => {
    botJobCreate.mockRejectedValueOnce(new Error("db blip"));
    await expect(inviteNamedPeople(ORG, tags([byPhone(users[0])]), { requesterUserId: null, now: NOW })).rejects.toThrow("db blip");
    expect(sentDelete).toHaveBeenCalledWith({ where: { key: "match-mnf:recruit-dm:u-bh" } });
  });

  it("at most ten DMs in one request", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, name: `P${i}`, phoneNumber: `+4477009010${String(i).padStart(2, "0")}` }));
    userFindMany.mockResolvedValue(many);
    membershipFindMany.mockResolvedValue(many.map((u) => member(u.id)));
    const r = await inviteNamedPeople(ORG, tags(many.map((u) => byPhone(u))), { requesterUserId: null, now: NOW });
    expect(botJobCreate).toHaveBeenCalledTimes(10);
    if (r.kind !== "done") throw new Error(r.kind);
    expect(r.plan.overCap.map((p) => p.userId)).toEqual(["u10", "u11"]);
  });

  it("only a game still to kick off (review #7); no place open, or no game: nobody DM'd", async () => {
    await inviteNamedPeople(ORG, tags([byPhone(users[0])]), { requesterUserId: null, now: NOW });
    expect(matchFindFirst.mock.calls[0][0].where.date).toEqual({ gt: NOW });
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
    botJobCreate.mockClear();
    expect(await inviteNamedPeople(ORG, tags([byPhone(users[0])]), { requesterUserId: null, now: NOW })).toEqual({ kind: "full", matchName: "Monday night vets", matchId: "match-mnf" });
    matchFindFirst.mockResolvedValueOnce(null);
    expect(await inviteNamedPeople(ORG, tags([byPhone(users[0])]), { requesterUserId: null, now: NOW })).toEqual({ kind: "no-match" });
    expect(botJobCreate).not.toHaveBeenCalled();
  });

  it("tags the Pi could not identify are carried to the reply", async () => {
    const r = await inviteNamedPeople(ORG, tags([], 2), { requesterUserId: null, now: NOW });
    if (r.kind !== "done") throw new Error(r.kind);
    expect(r.plan.unidentified).toBe(2);
    expect(botJobCreate).not.toHaveBeenCalled();
  });
});
