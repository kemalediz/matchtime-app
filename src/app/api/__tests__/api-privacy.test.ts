/**
 * MEMBER-FACING API ROUTES NEVER HAND A PLAIN MEMBER ADMIN-ONLY DATA.
 *
 * Found in the PR #148 review: `GET /api/players` only checked that the
 * caller belonged to the club, so any member calling it directly got
 * every team-mate's phone number, email and this club's seed rating.
 * The same audit found three siblings with the same shape:
 *
 *   - `GET /api/players/:id` handed ANY signed-in user the phone and
 *     email of ANY user id, with no club check at all;
 *   - `GET /api/matches/:id` returned any club's match to any signed-in
 *     user, and each attendance row carried its payment fields
 *     (amount, method, Stripe session id, who confirmed a cash payment);
 *   - `GET /api/org/settings` gave a plain member the invite code, the
 *     WhatsApp group id, the Stripe status, the money collector and the
 *     list of members with a phone.
 *
 * The rule pinned here: phone, email, seed, club rating, aliases and
 * payment data reach OWNER, ADMIN and the platform superadmin only. A
 * plain member gets names, ids and public fields. Nothing crosses clubs.
 *
 * `next/server` is stubbed so handlers can be called directly; auth, db
 * and org are mocked. No live DB, no model calls.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const getUserOrg = vi.fn();
const isSuperadmin = vi.fn();

const membershipFindMany = vi.fn();
const membershipFindFirst = vi.fn();
const userFindUnique = vi.fn();
const matchFindUnique = vi.fn();
const organisationFindUnique = vi.fn();
const ratingFindMany = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  getUserOrg: (...a: unknown[]) => getUserOrg(...a),
  isSuperadmin: (...a: unknown[]) => isSuperadmin(...a),
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock("@/lib/player-stats", () => ({
  loadClubDisplayRatings: vi.fn().mockResolvedValue({}),
  loadPlayerSeasonStats: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/team-labels", () => ({ resolveTeamLabels: () => ["Red", "Yellow"] }));
vi.mock("@/lib/db", () => ({
  db: {
    activity: { findFirst: vi.fn().mockResolvedValue(null) },
    membership: {
      findMany: (...a: unknown[]) => membershipFindMany(...a),
      findFirst: (...a: unknown[]) => membershipFindFirst(...a),
    },
    userAlias: { findMany: vi.fn().mockResolvedValue([{ userId: "u-walt", alias: "walty", source: "manual" }]) },
    organisation: { findUnique: (...a: unknown[]) => organisationFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
    rating: { findMany: (...a: unknown[]) => ratingFindMany(...a) },
    moMVote: { findUnique: vi.fn().mockResolvedValue(null) },
    sport: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { GET as listPlayers } from "@/app/api/players/route";
import { GET as getPlayer } from "@/app/api/players/[playerId]/route";
import { GET as getMatch } from "@/app/api/matches/[matchId]/route";
import { GET as getOrgSettings } from "@/app/api/org/settings/route";

const CLUB = "org-sutton";
const OTHER_CLUB = "org-elsewhere";
const ADMIN_ONLY_PLAYER_FIELDS = [
  "phoneNumber",
  "email",
  "seedRating",
  "clubRating",
  "aliases",
  "provisionallyAddedAt",
  "_count",
];

type Res = { body: Record<string, unknown>; status: number };

function rosterRow(id: string, name: string) {
  return {
    role: "PLAYER",
    leftAt: null,
    provisionallyAddedAt: null,
    seedRating: 7,
    user: {
      id,
      name,
      email: `${id}@example.com`,
      image: null,
      phoneNumber: "+447700900123",
      isActive: true,
      activityPositions: [{ positions: ["DEF"] }],
      _count: { attendances: 3 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "viewer" } });
  isSuperadmin.mockResolvedValue(false);
  membershipFindMany.mockResolvedValue([rosterRow("u-walt", "Walt")]);
  organisationFindUnique.mockResolvedValue({ lastParticipantSweepAt: null });
  ratingFindMany.mockResolvedValue([]);
});

// ─── GET /api/players ────────────────────────────────────────────────

describe("GET /api/players", () => {
  async function call(url = "http://localhost/api/players"): Promise<Res> {
    return (await listPlayers(new Request(url))) as unknown as Res;
  }

  it("gives a plain member names and ids but no phone, email, seed or aliases", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    const res = await call();
    expect(res.status).toBe(200);
    const players = res.body.players as Array<Record<string, unknown>>;
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ id: "u-walt", name: "Walt", positions: ["DEF"] });
    for (const f of ADMIN_ONLY_PLAYER_FIELDS) expect(players[0], f).not.toHaveProperty(f);
    expect(JSON.stringify(res.body)).not.toContain("+447700900123");
    expect(res.body).not.toHaveProperty("groupSync");
  });

  it("ignores includeFormer for a plain member (current members only)", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    await call("http://localhost/api/players?includeFormer=1");
    const where = membershipFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ orgId: CLUB, leftAt: null });
  });

  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`gives an ${role} the phone, email, seed and aliases`, async () => {
      getUserOrg.mockResolvedValue({ orgId: CLUB, role });
      const res = await call();
      const p = (res.body.players as Array<Record<string, unknown>>)[0];
      expect(p.phoneNumber).toBe("+447700900123");
      expect(p.email).toBe("u-walt@example.com");
      expect(p.seedRating).toBe(7);
      expect(p.aliases).toEqual([{ alias: "walty", source: "manual" }]);
      expect(res.body).toHaveProperty("groupSync");
    });
  }

  it("gives the platform superadmin the admin view even on a PLAYER membership", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    isSuperadmin.mockResolvedValue(true);
    const res = await call();
    const p = (res.body.players as Array<Record<string, unknown>>)[0];
    expect(p.phoneNumber).toBe("+447700900123");
    expect(p.seedRating).toBe(7);
  });

  it("only ever reads the caller's own club", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "OWNER" });
    await call();
    expect(membershipFindMany.mock.calls[0][0].where.orgId).toBe(CLUB);
  });
});

// ─── GET /api/players/:id ────────────────────────────────────────────

describe("GET /api/players/:id", () => {
  const target = {
    id: "u-walt",
    name: "Walt",
    email: "walt@example.com",
    image: null,
    phoneNumber: "+447700900123",
    activityPositions: [
      { positions: ["DEF"], activity: { id: "act-here", name: "Here", sportId: "s", isActive: true, orgId: CLUB } },
      { positions: ["GK"], activity: { id: "act-there", name: "There", sportId: "s", isActive: true, orgId: OTHER_CLUB } },
    ],
  };

  async function call(playerId: string): Promise<Res> {
    return (await getPlayer(new Request(`http://localhost/api/players/${playerId}`), {
      params: Promise.resolve({ playerId }),
    })) as unknown as Res;
  }

  beforeEach(() => {
    userFindUnique.mockResolvedValue(target);
    membershipFindFirst.mockResolvedValue({ id: "m-walt", orgId: CLUB });
  });

  it("gives a plain club-mate the name and positions but no phone or email", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    const res = await call("u-walt");
    expect(res.status).toBe(200);
    const p = res.body.player as Record<string, unknown>;
    expect(p).toMatchObject({ id: "u-walt", name: "Walt", positions: ["DEF"] });
    expect(p).not.toHaveProperty("phoneNumber");
    expect(p).not.toHaveProperty("email");
    expect(JSON.stringify(res.body)).not.toContain("+447700900123");
  });

  it("never shows another club's activities", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    const res = await call("u-walt");
    const aps = (res.body.player as { activityPositions: Array<{ activity: { id: string } }> }).activityPositions;
    expect(aps.map((a) => a.activity.id)).toEqual(["act-here"]);
    expect(JSON.stringify(res.body)).not.toContain(OTHER_CLUB);
  });

  it("404s a player who is not in the caller's club", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "OWNER" });
    membershipFindFirst.mockResolvedValue(null);
    const res = await call("u-walt");
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("+447700900123");
    const where = membershipFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "u-walt", orgId: CLUB });
  });

  it("404s any other player when the caller has no club", async () => {
    getUserOrg.mockResolvedValue(null);
    const res = await call("u-walt");
    expect(res.status).toBe(404);
  });

  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`gives an ${role} of the same club the phone and email`, async () => {
      getUserOrg.mockResolvedValue({ orgId: CLUB, role });
      const res = await call("u-walt");
      const p = res.body.player as Record<string, unknown>;
      expect(p.phoneNumber).toBe("+447700900123");
      expect(p.email).toBe("walt@example.com");
    });
  }

  it("gives the player their own phone and email on their own profile", async () => {
    authMock.mockResolvedValue({ user: { id: "u-walt" } });
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    const res = await call("u-walt");
    const p = res.body.player as Record<string, unknown>;
    expect(p.phoneNumber).toBe("+447700900123");
    expect(p.email).toBe("walt@example.com");
  });
});

// ─── GET /api/matches/:id ────────────────────────────────────────────

describe("GET /api/matches/:id", () => {
  const user = { id: "u-walt", name: "Walt", image: null, activityPositions: [] };
  const match = {
    id: "m1",
    activityId: "act-here",
    activity: { orgId: CLUB, sport: {}, org: { teamLabels: [], language: "en" } },
    attendances: [
      {
        id: "att1",
        matchId: "m1",
        userId: "u-walt",
        status: "CONFIRMED",
        position: 1,
        paidAt: new Date(0),
        paidViaUserId: "u-other",
        paymentMethod: "card",
        paymentAmount: 8,
        paymentQuantity: 1,
        stripeSessionId: "cs_live_secret",
        directPendingAt: null,
        directConfirmedByUserId: "u-admin",
        user,
      },
    ],
    teamAssignments: [],
  };

  async function call(): Promise<Res> {
    return (await getMatch(new Request("http://localhost/api/matches/m1"), {
      params: Promise.resolve({ matchId: "m1" }),
    })) as unknown as Res;
  }

  beforeEach(() => {
    matchFindUnique.mockResolvedValue(match);
    membershipFindFirst.mockResolvedValue({ id: "m-viewer" });
  });

  it("404s a match from a club the caller does not belong to", async () => {
    membershipFindFirst.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    const where = membershipFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "viewer", orgId: CLUB });
  });

  it("lets the platform superadmin read any club's match", async () => {
    membershipFindFirst.mockResolvedValue(null);
    isSuperadmin.mockResolvedValue(true);
    const res = await call();
    expect(res.status).toBe(200);
  });

  it("never carries attendance payment fields", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const att = (res.body.attendances as Array<Record<string, unknown>>)[0];
    expect(att).toMatchObject({ id: "att1", status: "CONFIRMED", userId: "u-walt" });
    for (const f of [
      "paidAt",
      "paidViaUserId",
      "paymentMethod",
      "paymentAmount",
      "paymentQuantity",
      "stripeSessionId",
      "directPendingAt",
      "directConfirmedByUserId",
    ]) {
      expect(att, f).not.toHaveProperty(f);
    }
    expect(JSON.stringify(res.body)).not.toContain("cs_live_secret");
  });
});

// ─── GET /api/org/settings ───────────────────────────────────────────

describe("GET /api/org/settings", () => {
  const org = {
    id: CLUB,
    name: "Sutton FC",
    slug: "sutton",
    inviteCode: "SECRET-INVITE",
    whatsappGroupId: "120363000000@g.us",
    whatsappBotEnabled: true,
    _count: { memberships: 20 },
    teamLabels: [],
    language: "en",
    featureAttendance: true,
    featureBench: true,
    featureTeamBalancing: true,
    featureMomVoting: true,
    featurePlayerRating: true,
    featureReminders: true,
    featureStatsQa: true,
    paymentTrackingEnabled: true,
    paymentCollectionEnabled: true,
    payMethodPayByBank: false,
    payMethodCard: true,
    payMethodDirect: true,
    stripeConnectAccountId: "acct_secret",
    stripeChargesEnabled: true,
    paymentHolderId: "u-admin",
  };

  async function call(): Promise<Res> {
    return (await getOrgSettings()) as unknown as Res;
  }

  beforeEach(() => {
    organisationFindUnique.mockResolvedValue(org);
    membershipFindMany.mockResolvedValue([{ user: { id: "u-walt", name: "Walt" } }]);
  });

  it("gives a plain member the club name and features only", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "PLAYER" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: CLUB, name: "Sutton FC", language: "en" });
    for (const f of [
      "inviteCode",
      "whatsappGroupId",
      "stripeConnected",
      "stripeChargesEnabled",
      "paymentHolderId",
      "members",
    ]) {
      expect(res.body, f).not.toHaveProperty(f);
    }
    expect(JSON.stringify(res.body)).not.toContain("SECRET-INVITE");
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it("gives an OWNER the invite code, group id, Stripe status and collector list", async () => {
    getUserOrg.mockResolvedValue({ orgId: CLUB, role: "OWNER" });
    const res = await call();
    expect(res.body).toMatchObject({
      inviteCode: "SECRET-INVITE",
      whatsappGroupId: "120363000000@g.us",
      stripeConnected: true,
      paymentHolderId: "u-admin",
      members: [{ id: "u-walt", name: "Walt" }],
    });
  });
});
