/**
 * THE OWNER'S POOL FUNNEL, the thin I/O half (growth slice G2, 2026-10-24).
 * It reads the facts; `funnel-rules.ts` decides every number. Callers are
 * superadmin only (the page and its CSV route check first).
 *
 * PRIVACY: counts only. About a person this selects his user id (to join
 * his offers, guest places and memberships), when he signed up, his status,
 * town, sport keys, source and early-list mark, and only the ids and
 * results of his games. Never a name, a number, an area or a distance
 * (`__tests__/funnel-loader.test.ts` pins the selects).
 */
import { db } from "../db";
import { ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { POOL_OFFER_PURPOSE } from "./dispatch";
import {
  buildFunnelReport,
  buildOfferHealth,
  rangeInstants,
  type FunnelProfileFact,
  type FunnelQuery,
  type FunnelReport,
  type OfferHealth,
  type OfferHealthFacts,
} from "./funnel-rules";
import type { AttendanceLike, MatchStatusLike } from "./guest-report";
import { GUEST_RESULTS, isOneOf } from "./vocab";

const HOUR_MS = 3600_000;
/** The platform's day cap looks back at most one London day (25 hours). */
const CAP_LOOKBACK_MS = 26 * HOUR_MS;

async function loadProfiles(): Promise<FunnelProfileFact[]> {
  const profiles = await db.poolProfile.findMany({
    select: { userId: true, createdAt: true, status: true, consentAt: true, town: true, source: true, sourceCode: true, earlyList: true, sports: { select: { sport: true } } },
  });
  const userIds = profiles.map((p) => p.userId).filter((id): id is string => !!id);

  const [offers, places] = userIds.length
    ? await Promise.all([
        db.poolOffer.groupBy({ by: ["userId"], where: { userId: { in: userIds }, sentAt: { not: null } }, _count: { _all: true } }),
        db.guestPlace.findMany({ where: { userId: { in: userIds }, source: "pool" }, select: { userId: true, orgId: true, matchId: true, result: true } }),
      ])
    : [[], []];

  const placeUsers = [...new Set(places.map((p) => p.userId))];
  const [matches, attendance, memberships] = places.length
    ? await Promise.all([
        db.match.findMany({
          where: { id: { in: [...new Set(places.map((p) => p.matchId))] } },
          select: { id: true, date: true, status: true, activity: { select: { matchDurationMins: true } } },
        }),
        db.attendance.findMany({
          where: { userId: { in: placeUsers }, matchId: { in: places.map((p) => p.matchId) } },
          select: { userId: true, matchId: true, status: true },
        }),
        db.membership.findMany({
          where: { userId: { in: placeUsers }, orgId: { in: [...new Set(places.map((p) => p.orgId))] }, leftAt: null, ...ORDINARY_MEMBER_WHERE },
          select: { userId: true, orgId: true },
        }),
      ])
    : [[], [], []];

  const offered = new Map(offers.map((o) => [o.userId, o._count._all]));
  const matchOf = new Map(matches.map((m) => [m.id, { kickoff: m.date, durationMins: m.activity.matchDurationMins, status: m.status as MatchStatusLike }]));
  const attendanceOf = new Map(attendance.map((a) => [`${a.matchId}:${a.userId}`, a.status as AttendanceLike]));
  const placesOf = new Map<string, FunnelProfileFact["places"]>();
  for (const p of places) {
    const match = matchOf.get(p.matchId);
    if (!match) continue;
    const list = placesOf.get(p.userId) ?? [];
    list.push({ orgId: p.orgId, match, attendance: attendanceOf.get(`${p.matchId}:${p.userId}`) ?? null, recorded: isOneOf(GUEST_RESULTS, p.result) ? p.result : "booked" });
    placesOf.set(p.userId, list);
  }
  const membersOf = new Map<string, string[]>();
  for (const m of memberships) membersOf.set(m.userId, [...(membersOf.get(m.userId) ?? []), m.orgId]);

  return profiles.map((p) => ({
    createdAt: p.createdAt,
    status: p.status,
    verified: p.consentAt !== null,
    town: p.town,
    sports: p.sports.map((s) => s.sport),
    source: p.source,
    sourceCode: p.sourceCode,
    earlyList: p.earlyList,
    offersDelivered: (p.userId && offered.get(p.userId)) || 0,
    places: (p.userId && placesOf.get(p.userId)) || [],
    memberOrgIds: (p.userId && membersOf.get(p.userId)) || [],
  }));
}

async function loadOfferHealthFacts(q: FunnelQuery): Promise<OfferHealthFacts> {
  const { start, end } = rangeInstants(q);
  const [offerJobs, delivered, paused] = await Promise.all([
    db.platformJob.findMany({
      where: { purpose: POOL_OFFER_PURPOSE, OR: [{ createdAt: { gte: start, lt: end } }, { failedAt: { gte: start, lt: end } }] },
      select: { createdAt: true, sendAfter: true, failReason: true, failedAt: true },
    }),
    db.poolOffer.findMany({ where: { sentAt: { gte: new Date(start.getTime() - CAP_LOOKBACK_MS), lt: end } }, select: { sentAt: true } }),
    db.poolProfile.findMany({ where: { status: "paused", pausedReason: "ignored" }, select: { pausedAt: true } }),
  ]);
  return {
    offerJobs,
    delivered: delivered.map((o) => o.sentAt).filter((d): d is Date => !!d),
    ignoredPausedAt: paused.map((p) => p.pausedAt).filter((d): d is Date => !!d),
  };
}

export async function loadPoolFunnel(q: FunnelQuery, now: Date = new Date()): Promise<{ report: FunnelReport; health: OfferHealth }> {
  const [profiles, campaigns, healthFacts] = await Promise.all([
    loadProfiles(),
    db.poolCampaign.findMany({ select: { code: true, label: true, source: true }, orderBy: { createdAt: "desc" } }),
    loadOfferHealthFacts(q),
  ]);
  return { report: buildFunnelReport({ profiles, campaigns, now }, q), health: buildOfferHealth(healthFacts, q) };
}
