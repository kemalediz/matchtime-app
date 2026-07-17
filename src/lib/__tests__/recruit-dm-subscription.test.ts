/**
 * Sender-gating test for the RECRUIT / match-invite category.
 *
 * Exercises the REAL src/lib/recruit.ts `inviteRecentPlayers` with the DB
 * and its collaborators mocked, and asserts a candidate whose membership
 * has subMatchInviteDm=false is EXCLUDED from the invite blast, while a
 * subscribed candidate still gets a DM.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const membershipFindMany = vi.fn();
const matchFindFirst = vi.fn();
const matchFindMany = vi.fn();
const sentFindUnique = vi.fn();
const sentCreate = vi.fn();
const botJobCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    match: { findFirst: (...a: unknown[]) => matchFindFirst(...a), findMany: (...a: unknown[]) => matchFindMany(...a) },
    membership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    sentNotification: {
      findUnique: (...a: unknown[]) => sentFindUnique(...a),
      create: (...a: unknown[]) => sentCreate(...a),
    },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
  },
}));
vi.mock("@/lib/magic-link", () => ({ signMagicLinkToken: () => "tok", MAGIC_LINK_TTL: { actionNudge: 1 } }));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async () => "https://s/x" }));
vi.mock("@/lib/london-time", () => ({ formatLondon: () => "Tue 22 Jul, 21:30" }));
vi.mock("@/lib/org-features", () => ({ getOrgFeatures: async () => ({ attendance: true }) }));

import { inviteRecentPlayers } from "@/lib/recruit";

const ORG = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
  // Next upcoming match — nobody has responded, plenty of open spots.
  matchFindFirst.mockResolvedValue({
    id: "match-next",
    date: new Date("2026-07-22T20:30:00Z"),
    maxPlayers: 10,
    activity: { name: "Tuesday Footy" },
    attendances: [],
  });
  // Recent completed match with two prior attendees, both with a phone.
  matchFindMany.mockResolvedValue([
    {
      attendances: [
        { userId: "p-optedout", user: { id: "p-optedout", name: "Opt Out", phoneNumber: "+447700900001" } },
        { userId: "p-subbed", user: { id: "p-subbed", name: "Sub Scribed", phoneNumber: "+447700900002" } },
      ],
    },
  ]);
  sentFindUnique.mockResolvedValue(null); // nobody invited yet
  sentCreate.mockResolvedValue({});
  botJobCreate.mockResolvedValue({});
});

describe("inviteRecentPlayers — subMatchInviteDm gating", () => {
  it("EXCLUDES a candidate who opted out of match-invite DMs, DMs the subscribed one", async () => {
    // p-optedout has subMatchInviteDm=false.
    membershipFindMany.mockResolvedValue([{ userId: "p-optedout" }]);

    const res = await inviteRecentPlayers(ORG);

    expect(res.ok).toBe(true);
    // Exactly one invite DM queued — to the subscribed player.
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    const phones = botJobCreate.mock.calls.map((c) => (c[0] as { data: { phone: string } }).data.phone);
    expect(phones).toEqual(["447700900002"]); // p-subbed only
    expect(res.invitedNames).toEqual(["Sub Scribed"]);

    // The opt-out query targeted the right flag.
    expect(membershipFindMany).toHaveBeenCalledWith({
      where: { orgId: ORG, subMatchInviteDm: false },
      select: { userId: true },
    });
  });

  it("DMs BOTH candidates when nobody opted out", async () => {
    membershipFindMany.mockResolvedValue([]); // no opt-outs

    const res = await inviteRecentPlayers(ORG);

    expect(botJobCreate).toHaveBeenCalledTimes(2);
    expect(res.invited).toBe(2);
  });
});
