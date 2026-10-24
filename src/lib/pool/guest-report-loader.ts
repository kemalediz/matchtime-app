/**
 * THE GUEST PLAYERS PAGE'S LOADER (slice L5b, 2026-10-24). Thin I/O around
 * the pure read model in `guest-report.ts`: it reads the facts, the pure
 * functions decide everything.
 *
 * PRIVACY (plan section 6). This file selects, about a guest: his user id,
 * his name, his games' results, his pool profile's status and sports, and
 * his invitations from this club (L8). Never his phone number, his area, or the
 * clubs he plays for. The one club name it reads is the partner club a
 * partner guest came from, which this club asked. His games at other clubs
 * are read for his turn-up record as results only (no club, no venue, no
 * sport), and `__tests__/guest-report-loader.test.ts` pins the selects.
 *
 * Who is a guest of this club: anyone with a `GuestPlace` row here, and
 * anyone holding (or who held) a guest membership here. A partner guest from
 * before the pool has no `GuestPlace` row; his games are his attendance rows
 * on this club's matches (he is no member, so each one is a guest game).
 */
import { GUEST_MEMBER_WHERE, guestSourceOf, isGuestMembership } from "../guest-membership";
import { db } from "../db";
import type { GuestPoolState } from "./club-invite";
import type { Lang } from "../i18n/lang";
import { buildGuestPlayers } from "./guest-report";
import { invitationView } from "./club-invitation-rules";
import type {
  AttendanceLike,
  GuestCard,
  GuestGameFact,
  GuestMatchFacts,
  GuestPersonFacts,
  GuestSportFact,
  MatchStatusLike,
  ReportAskFact,
} from "./guest-report";
import { isOneOf, GUEST_RESULTS, GUEST_SOURCES, POOL_PROFILE_STATUSES, type GuestResult, type GuestSource } from "./vocab";
import { SPORT_LEVELS, type PoolSportChoiceKey } from "./sports";

export interface GuestFacts {
  games: GuestGameFact[];
  people: GuestPersonFacts[];
  /** Only with `report: true`. */
  asks: ReportAskFact[];
  /** This club's matches with a guest game or an ask. */
  matches: GuestMatchFacts[];
  /** Guests who are ordinary members of this club now. */
  members: Set<string>;
}

const isMemberRow = (m: { leftAt: Date | null; guestMatchId: string | null; guestFromOrgId: string | null }) =>
  m.leftAt === null && !isGuestMembership(m);

export async function loadGuestFacts(orgId: string, opts: { userIds?: string[]; report?: boolean; now?: Date } = {}): Promise<GuestFacts> {
  const onlyUsers = opts.userIds ? { userId: { in: opts.userIds } } : {};

  const [guestMemberships, placesHere] = await Promise.all([
    db.membership.findMany({
      where: { orgId, ...onlyUsers, ...GUEST_MEMBER_WHERE },
      select: { userId: true, guestFromOrgId: true, guestVia: true },
    }),
    db.guestPlace.findMany({
      where: { orgId, ...onlyUsers },
      select: { userId: true, matchId: true, source: true, fromOrgId: true, result: true, settledAt: true },
    }),
  ]);

  const userIds = [...new Set([...guestMemberships.map((m) => m.userId), ...placesHere.map((p) => p.userId)])];

  const [asks, partnerAsks] = opts.report
    ? await Promise.all([
        db.poolAsk.findMany({
          where: { orgId },
          select: { matchId: true, status: true, _count: { select: { offers: { where: { sentAt: { not: null } } } } } },
        }),
        db.partnerAsk.findMany({ where: { askerOrgId: orgId }, select: { matchId: true, status: true, volunteerUserIds: true } }),
      ])
    : [[], []];
  const askFacts: ReportAskFact[] = [
    ...asks.map((a) => ({ matchId: a.matchId, kind: "pool" as const, status: a.status, reached: a._count.offers })),
    ...partnerAsks.map((a) => ({ matchId: a.matchId, kind: "partner" as const, status: a.status, reached: a.volunteerUserIds.length })),
  ];

  if (userIds.length === 0 && askFacts.length === 0) return { games: [], people: [], asks: [], matches: [], members: new Set() };

  const [memberRows, users, profiles, invitations, placesElsewhere, legacyAttendance, clubBlocks] = await Promise.all([
    db.membership.findMany({
      where: { orgId, userId: { in: userIds } },
      select: { userId: true, leftAt: true, guestMatchId: true, guestFromOrgId: true },
    }),
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    db.poolProfile.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, status: true, sports: { select: { sport: true, otherName: true, level: true, levelText: true } } },
    }),
    db.clubInvitation.findMany({
      where: { orgId, userId: { in: userIds } },
      select: { userId: true, status: true, origin: true, clubYesAt: true, playerYesAt: true, declinedBy: true, closedAt: true, createdAt: true },
    }),
    db.guestPlace.findMany({ where: { userId: { in: userIds }, orgId: { not: orgId } }, select: { userId: true, matchId: true, result: true, settledAt: true } }),
    db.attendance.findMany({
      where: { userId: { in: guestMemberships.map((m) => m.userId) }, match: { activity: { orgId } } },
      select: { userId: true, matchId: true, status: true },
    }),
    // Slice L7: this club's own blocks (the card's "Offer our games again").
    db.poolBlock.findMany({ where: { orgId, userId: { in: userIds }, by: "club" }, select: { userId: true } }),
  ]);
  const blockedHere = new Set(clubBlocks.map((b) => b.userId));

  const recordedHere = new Set(placesHere.map((p) => `${p.matchId}:${p.userId}`));
  const legacy = legacyAttendance.filter((a) => !recordedHere.has(`${a.matchId}:${a.userId}`));

  const matchIds = [
    ...new Set([...placesHere, ...placesElsewhere, ...legacy].map((g) => g.matchId).concat(askFacts.map((a) => a.matchId))),
  ];
  const [matchRows, attendance] = await Promise.all([
    db.match.findMany({
      where: { id: { in: matchIds } },
      select: {
        id: true,
        date: true,
        status: true,
        activity: { select: { orgId: true, venue: true, matchDurationMins: true, sport: { select: { id: true, name: true } } } },
      },
    }),
    db.attendance.findMany({
      where: { userId: { in: userIds }, matchId: { in: [...placesHere, ...placesElsewhere].map((p) => p.matchId) } },
      select: { userId: true, matchId: true, status: true },
    }),
  ]);

  const matchOf = new Map<string, GuestMatchFacts & { orgId: string }>();
  for (const m of matchRows) {
    const here = m.activity.orgId === orgId;
    matchOf.set(m.id, {
      matchId: m.id,
      orgId: m.activity.orgId,
      kickoff: m.date,
      durationMins: m.activity.matchDurationMins,
      status: m.status as MatchStatusLike,
      // Another club's match: results only, nothing that names or places it.
      sportId: here ? m.activity.sport.id : "",
      sportName: here ? m.activity.sport.name : "",
      venue: here ? m.activity.venue : "",
    });
  }
  const attendanceOf = new Map([...attendance, ...legacy].map((a) => [`${a.matchId}:${a.userId}`, a.status as AttendanceLike]));

  const fromOrgIds = [...new Set([...guestMemberships.map((m) => m.guestFromOrgId), ...placesHere.map((p) => p.fromOrgId)].filter((x): x is string => !!x))];
  const clubNames = new Map(
    fromOrgIds.length > 0
      ? (await db.organisation.findMany({ where: { id: { in: fromOrgIds } }, select: { id: true, name: true } })).map((o) => [o.id, o.name])
      : [],
  );
  const membershipOf = new Map(guestMemberships.map((m) => [m.userId, m]));

  const toFact = (
    g: { userId: string; matchId: string },
    recorded: GuestResult | null,
    source: GuestSource,
    fromOrgId: string | null,
    settled = false,
  ): GuestGameFact | null => {
    const m = matchOf.get(g.matchId);
    if (!m) return null;
    const { orgId: matchOrg, ...match } = m;
    return {
      userId: g.userId,
      orgId: matchOrg,
      match,
      attendance: attendanceOf.get(`${g.matchId}:${g.userId}`) ?? null,
      recorded,
      settled,
      source,
      fromClub: source === "partner" && fromOrgId ? (clubNames.get(fromOrgId) ?? null) : null,
    };
  };
  const result = (r: string): GuestResult | null => (isOneOf(GUEST_RESULTS, r) ? r : null);
  const source = (s: string | null | undefined): GuestSource => (isOneOf(GUEST_SOURCES, s) ? s : "partner");

  const games = [
    ...placesHere.map((p) => toFact(p, result(p.result) ?? "booked", source(p.source), p.fromOrgId, p.settledAt !== null)),
    ...placesElsewhere.map((p) => toFact(p, result(p.result) ?? "booked", "pool", null, p.settledAt !== null)),
    ...legacy.map((a) => {
      const gm = membershipOf.get(a.userId);
      return toFact(a, null, source(guestSourceOf(gm) ?? "pool"), gm?.guestFromOrgId ?? null);
    }),
  ].filter((g): g is GuestGameFact => g !== null);

  const members = new Set(memberRows.filter(isMemberRow).map((m) => m.userId));
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const profileOf = new Map(profiles.map((p) => [p.userId, p]));
  const invitationsOf = new Map<string, typeof invitations>();
  for (const i of invitations) invitationsOf.set(i.userId, [...(invitationsOf.get(i.userId) ?? []), i]);
  const now = opts.now ?? new Date();
  const people: GuestPersonFacts[] = userIds.map((userId) => {
    const profile = profileOf.get(userId);
    const cameViaPool = games.some((g) => g.userId === userId && g.orgId === orgId && g.source === "pool");
    const pool: GuestPoolState = profile
      ? isOneOf(POOL_PROFILE_STATUSES, profile.status)
        ? profile.status
        : "active"
      : cameViaPool
        ? "deleted"
        : "none";
    return {
      userId,
      name: nameOf.get(userId) ?? null,
      member: members.has(userId),
      pool,
      poolSports: (profile?.sports ?? []).map(
        (s): GuestSportFact => ({
          sport: s.sport as PoolSportChoiceKey,
          otherName: s.otherName,
          level: isOneOf(SPORT_LEVELS, s.level) ? s.level : null,
          levelText: s.levelText,
        }),
      ),
      invitation: invitationView(invitationsOf.get(userId) ?? [], now),
      clubBlocked: blockedHere.has(userId),
    };
  });

  const matches = [...matchOf.values()].filter((m) => m.orgId === orgId).map(({ orgId: _o, ...m }) => m);
  return { games, people, asks: askFacts, matches, members };
}

/**
 * The guests on one match of this club, for the match page's Guest tag and
 * card: the people with a guest place on it or a guest membership for it.
 */
export async function loadMatchGuestIds(orgId: string, matchId: string, attendeeIds: string[]): Promise<string[]> {
  if (attendeeIds.length === 0) return [];
  const [places, memberships] = await Promise.all([
    db.guestPlace.findMany({ where: { orgId, matchId }, select: { userId: true } }),
    db.membership.findMany({
      where: { orgId, userId: { in: attendeeIds }, ...GUEST_MEMBER_WHERE },
      select: { userId: true, leftAt: true, guestMatchId: true },
    }),
  ]);
  const ids = new Set(places.map((p) => p.userId));
  for (const m of memberships) if (m.leftAt === null || m.guestMatchId === matchId) ids.add(m.userId);
  return attendeeIds.filter((id) => ids.has(id));
}

/**
 * Does the admin area show the Guest players tab? Only for a club that may
 * ask the pool, or that has had a guest (decision log L5b.1): every other
 * club's tabs stay exactly as they were.
 */
export async function guestPlayersTabShown(orgId: string): Promise<boolean> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true } });
  if (org?.featurePlayerPool) return true;
  const [guest, place] = await Promise.all([
    db.membership.findFirst({
      where: { orgId, ...GUEST_MEMBER_WHERE },
      select: { id: true },
    }),
    db.guestPlace.findFirst({ where: { orgId }, select: { id: true } }),
  ]);
  return guest !== null || place !== null;
}

/**
 * The match page's Guest tags: every guest on the match, with his card for
 * an organiser (`admin`), or null (the plain tag) for anyone else.
 */
export async function loadMatchGuestCards(args: {
  orgId: string;
  matchId: string;
  attendeeIds: string[];
  lang: Lang;
  admin: boolean;
  now?: Date;
}): Promise<Record<string, GuestCard | null>> {
  const ids = await loadMatchGuestIds(args.orgId, args.matchId, args.attendeeIds);
  if (ids.length === 0) return {};
  if (!args.admin) return Object.fromEntries(ids.map((id) => [id, null]));
  const facts = await loadGuestFacts(args.orgId, { userIds: ids, now: args.now });
  const built = buildGuestPlayers({ orgId: args.orgId, now: args.now ?? new Date(), lang: args.lang, games: facts.games, people: facts.people });
  return Object.fromEntries(ids.map((id) => [id, built.cards[id] ?? null]));
}
