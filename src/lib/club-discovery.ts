/**
 * FINDING CLUBS NEARBY: the loader (partner discovery, slice P2,
 * 2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 2.2
 * and 2.3. The rules are club-discovery-rules.ts; this file only reads.
 *
 * SCALE. One candidate query, cut by a bounding box on `Venue.lat`/`lng`
 * (the index from slice P1) around each of our venues, then the exact
 * distance in code with `distanceKm`. A 10-mile box holds a few hundred
 * clubs at most. Pages of 50, nearest first. Regular players are counted
 * for the page's clubs only, in one more query.
 *
 * PRIVACY (2.3). The other clubs' select (`NEARBY_CLUB_SELECT`) reads no
 * member, no user, no group, no link, no fee, no rating and no match; the
 * members are a COUNT. Positions are read to measure and never returned:
 * what leaves this file is `NearbyClubCard`, built field by field. Pinned
 * by src/lib/__tests__/club-discovery.test.ts.
 *
 * Who may call it (an owner or admin of `orgId`) is proven by the caller.
 */
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { isClubApproved } from "./club-approval-state";
import {
  DEFAULT_RADIUS_MILES,
  LISTABLE_CLUB_WHERE,
  NEARBY_PAGE_SIZE,
  REGULAR_LAST_GAMES,
  boundingBox,
  cardStatus,
  hiddenOrgIds,
  inRange,
  measuredFrom,
  nearestMiles,
  parseRadiusMiles,
  regularPlayers,
  roundMiles,
  sameDayKeeps,
  searcherState,
  townOf,
  type NearbyClubCard,
  type RadiusMiles,
  type RelationRow,
  type SearcherState,
} from "./club-discovery-rules";

/** Our own club: whether it may search, and where from. */
const SEARCHER_SELECT = {
  id: true,
  approvalStatus: true,
  // Our own group, read only to know we have one.
  whatsappGroupId: true,
  discoverable: true,
  homeVenue: { select: { lat: true, lng: true } },
  activities: { where: { isActive: true }, select: { isActive: true, dayOfWeek: true, venueRef: { select: { lat: true, lng: true } } } },
} as const;

const VENUE_FIELDS = { select: { name: true, formattedAddress: true, lat: true, lng: true } } as const;

/** Another club, for its card. NOTHING ELSE may be added here. */
export const NEARBY_CLUB_SELECT = {
  id: true,
  name: true,
  homeVenue: VENUE_FIELDS,
  activities: {
    where: { isActive: true },
    select: { dayOfWeek: true, time: true, sport: { select: { playersPerTeam: true } }, venueRef: VENUE_FIELDS },
  },
  _count: { select: { memberships: { where: { leftAt: null, ...ORDINARY_MEMBER_WHERE } } } },
} as const;

interface VenueRow {
  name: string;
  formattedAddress: string | null;
  lat: number | null;
  lng: number | null;
}
interface CandidateRow {
  id: string;
  name: string;
  homeVenue: VenueRow | null;
  activities: Array<{ dayOfWeek: number; time: string; sport: { playersPerTeam: number } | null; venueRef: VenueRow | null }>;
  _count: { memberships: number };
}

export type NearbySearch =
  | { state: Exclude<SearcherState, "ok"> }
  | {
      state: "ok";
      radiusMiles: RadiusMiles;
      sameDay: boolean;
      /** We have a game day to compare: the same-day switch means something. */
      canFilterSameDay: boolean;
      page: number;
      pageCount: number;
      total: number;
      clubs: NearbyClubCard[];
    };

export async function loadNearbyClubs(
  orgId: string,
  opts: { radiusMiles?: RadiusMiles; sameDay?: boolean; page?: number; now?: Date } = {},
): Promise<NearbySearch | null> {
  const now = opts.now ?? new Date();
  const radiusMiles = parseRadiusMiles(opts.radiusMiles ?? DEFAULT_RADIUS_MILES);
  const sameDay = opts.sameDay === true;

  const me = await db.organisation.findUnique({ where: { id: orgId }, select: SEARCHER_SELECT });
  if (!me) return null;
  const mine = {
    approved: isClubApproved(me),
    hasPlayersGroup: !!me.whatsappGroupId,
    discoverable: me.discoverable,
    homeVenue: me.homeVenue,
    games: me.activities.map((a) => ({ isActive: a.isActive, venue: a.venueRef })),
  };
  const state = searcherState(mine);
  if (state !== "ok") return { state };

  const origins = measuredFrom(mine).map((p) => ({ lat: p.lat, lng: p.lng }));
  const ourDays = [...new Set(me.activities.map((a) => a.dayOfWeek))];
  const boxes = origins.map((o) => boundingBox(o, radiusMiles));
  const inBox = (b: (typeof boxes)[number]) => ({ lat: { gte: b.minLat, lte: b.maxLat }, lng: { gte: b.minLng, lte: b.maxLng } });

  const [candidates, blocks, partnerships] = await Promise.all([
    db.organisation.findMany({
      where: {
        ...LISTABLE_CLUB_WHERE,
        id: { not: orgId },
        OR: boxes.flatMap((b) => [
          { activities: { some: { isActive: true, venueRef: { is: inBox(b) } } } },
          { homeVenue: { is: inBox(b) } },
        ]),
      },
      select: NEARBY_CLUB_SELECT,
    }) as Promise<CandidateRow[]>,
    db.clubBlock.findMany({
      where: { OR: [{ blockerOrgId: orgId }, { blockedOrgId: orgId }] },
      select: { blockerOrgId: true, blockedOrgId: true },
    }),
    db.clubPartnership.findMany({
      where: { OR: [{ askerOrgId: orgId }, { partnerOrgId: orgId }] },
      select: {
        askerOrgId: true,
        partnerOrgId: true,
        status: true,
        askerAcceptedAt: true,
        partnerAcceptedAt: true,
        endReason: true,
        endedByOrgId: true,
        endedAt: true,
      },
    }) as Promise<RelationRow[]>,
  ]);

  const hidden = hiddenOrgIds({ selfOrgId: orgId, blocks, partnerships, now });
  const listed: Array<{ row: CandidateRow; miles: number; venue: VenueRow }> = [];
  for (const row of candidates) {
    if (hidden.has(row.id)) continue;
    const theirs = measuredFrom({
      homeVenue: row.homeVenue,
      games: row.activities.map((a) => ({ isActive: true, venue: a.venueRef })),
    });
    const nearest = nearestMiles(origins, theirs);
    if (!nearest || !inRange(nearest.miles, radiusMiles)) continue;
    if (!sameDayKeeps(ourDays, row.activities.map((a) => a.dayOfWeek), sameDay)) continue;
    listed.push({ row, miles: nearest.miles, venue: theirs[nearest.theirIndex] });
  }
  listed.sort((a, b) => a.miles - b.miles || a.row.name.localeCompare(b.row.name));

  const total = listed.length;
  const pageCount = Math.max(1, Math.ceil(total / NEARBY_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), pageCount);
  const slice = listed.slice((page - 1) * NEARBY_PAGE_SIZE, page * NEARBY_PAGE_SIZE);
  const regulars = await loadRegularPlayers(slice.map((x) => x.row.id), now);

  const clubs: NearbyClubCard[] = slice.map(({ row, miles, venue }) => ({
    orgId: row.id,
    name: row.name,
    venueName: venue.name,
    town: townOf(venue.formattedAddress),
    miles: roundMiles(miles),
    games: row.activities
      .map((a) => ({ dow: a.dayOfWeek, time: a.time, perSide: a.sport?.playersPerTeam ?? 0 }))
      .sort((a, b) => a.dow - b.dow || a.time.localeCompare(b.time)),
    members: row._count.memberships,
    regulars: regulars.get(row.id) ?? 0,
    status: cardStatus(orgId, row.id, partnerships),
  }));

  return { state: "ok", radiusMiles, sameDay, canFilterSameDay: ourDays.length > 0, page, pageCount, total, clubs };
}

/**
 * Regular players per club: of each club's last 8 completed games, who
 * played (CONFIRMED) at least 2, counting live non-guest members only. One
 * query for the page; ids and counts in, a number per club out.
 */
async function loadRegularPlayers(orgIds: string[], now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orgIds.length === 0) return out;
  const rows = await db.$queryRaw<Array<{ orgId: string; matchId: string; userId: string }>>`
    WITH last AS (
      SELECT m.id, a."orgId",
             row_number() OVER (PARTITION BY a."orgId" ORDER BY m.date DESC) AS rn
        FROM "Match" m
        JOIN "Activity" a ON a.id = m."activityId"
       WHERE a."orgId" = ANY(${orgIds}::text[])
         AND m.status = 'COMPLETED'
         AND m.date < ${now}
    )
    SELECT l."orgId", l.id AS "matchId", at."userId"
      FROM last l
      JOIN "Attendance" at ON at."matchId" = l.id AND at.status = 'CONFIRMED'
      JOIN "Membership" ms ON ms."userId" = at."userId" AND ms."orgId" = l."orgId"
                          AND ms."leftAt" IS NULL AND ms."guestMatchId" IS NULL
     WHERE l.rn <= ${REGULAR_LAST_GAMES}`;
  const byOrg = new Map<string, Map<string, string[]>>();
  for (const r of rows) {
    const games = byOrg.get(r.orgId) ?? new Map<string, string[]>();
    games.set(r.matchId, [...(games.get(r.matchId) ?? []), r.userId]);
    byOrg.set(r.orgId, games);
  }
  for (const [id, games] of byOrg) out.set(id, regularPlayers([...games.values()].map((userIds) => ({ userIds }))));
  return out;
}
