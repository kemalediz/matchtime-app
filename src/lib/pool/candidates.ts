/**
 * THE POOL'S CANDIDATE LOADER (slice L4, 2026-10-24). Thin I/O: it reads
 * the match and the pool's tables, hands plain rows to the pure rules
 * (`candidate-rows.ts` to build them, `matching-rules.ts` to judge them,
 * `waves.ts` for the send time) and returns what they decide. No rule
 * lives here.
 *
 *   findPoolCandidates  who may be offered this match now, ranked. For L5's
 *                       round runner (pool code only: it carries ids).
 *   poolNearBand        "players near you" for the organiser: a band
 *                       ("none" | "few" | "5+") and nothing else.
 *   poolPlatformRoom    how many more pool DMs may go now (platform caps;
 *                       the locking design for dispatch is in caps.ts).
 *
 * The switches (`flags.ts`) are checked first: with the global switch or
 * the club's flag off, no pool table is read at all.
 */
import { db } from "../db";
import { boundingBox } from "../club-discovery-rules";
import { platformRoom } from "./caps";
import { candidateRowsOf, matchContextOf, type RawOffer } from "./candidate-rows";
import { poolOffersOpenForClub } from "./flags";
import { OPEN_MATCH_STATUSES, selectCandidates, type PoolMatchContext, type Selection } from "./matching-rules";
import { nearBand, type PoolNearBand } from "./near-band";
import { POOL_CAPS, POOL_TRAVEL_MILES } from "./rules";
import type { SportLevel } from "./sports";
import { poolSendAt } from "./waves";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** Offers old enough to matter to a cap: the cooldown plus a week. */
const LEDGER_LOOKBACK_MS = (POOL_CAPS.declineCooldownDays + 7) * DAY_MS;
/** Own-club games looked at for "his most recent game". */
const LAST_GAME_LOOKBACK_MS = 365 * DAY_MS;

type Env = Record<string, string | undefined>;
export interface FindOptions {
  now?: Date;
  env?: Env;
  /** The levels the ask names; null: any. */
  levels?: readonly SportLevel[] | null;
}

export interface FoundCandidates {
  ctx: PoolMatchContext | null;
  /** When an offer queued now would reach people (quiet hours deferred). */
  sendAt: Date;
  selection: Selection;
}

const closed = (gate: Selection["gate"], sendAt: Date, ctx: PoolMatchContext | null = null): FoundCandidates => ({
  ctx,
  sendAt,
  selection: { gate, eligible: [], excluded: {} },
});

export async function findPoolCandidates(matchId: string, opts: FindOptions = {}): Promise<FoundCandidates> {
  const now = opts.now ?? new Date();
  const sendAt = poolSendAt(now);

  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      activity: {
        select: {
          orgId: true,
          matchDurationMins: true,
          venueRef: { select: { lat: true, lng: true } },
          sport: { select: { preset: true, name: true, playersPerTeam: true } },
          org: { select: { featurePlayerPool: true } },
        },
      },
    },
  });
  if (!match) return closed("match-not-open", sendAt);

  const ctx = matchContextOf(match, poolOffersOpenForClub(match.activity.org, opts.env), opts.levels ?? null);
  const gated = selectCandidates(ctx, [], now, sendAt);
  if (gated.gate || !ctx.venue || !ctx.sport) return closed(gated.gate, sendAt, ctx);

  // Coarse cut in SQL: his postcode area's centre inside the widest travel
  // box; the exact distance is the rules'.
  const box = boundingBox(ctx.venue, Math.max(...POOL_TRAVEL_MILES));
  const profiles = await db.poolProfile.findMany({
    where: {
      status: "active",
      userId: { not: null },
      consentAt: { not: null },
      sports: { some: { sport: ctx.sport.sport } },
      areaLat: { gte: box.minLat, lte: box.maxLat },
      areaLng: { gte: box.minLng, lte: box.maxLng },
    },
    select: {
      userId: true,
      status: true,
      consentAt: true,
      maxMiles: true,
      areaLat: true,
      areaLng: true,
      user: { select: { phoneNumber: true } },
      sports: { select: { sport: true, formats: true, level: true } },
      availability: { select: { day: true, fromMin: true, toMin: true } },
    },
  });
  if (profiles.length === 0) return { ctx, sendAt, selection: selectCandidates(ctx, [], now, sendAt) };

  const userIds = profiles.map((p) => p.userId as string);
  const kickoff = ctx.kickoff;

  const [members, onMatch, blocks, offers, busy, guestPlaces, ownGames] = await Promise.all([
    db.membership.findMany({ where: { orgId: ctx.orgId, userId: { in: userIds }, leftAt: null, guestMatchId: null }, select: { userId: true } }),
    db.attendance.findMany({ where: { matchId, userId: { in: userIds } }, select: { userId: true } }),
    db.poolBlock.findMany({ where: { orgId: ctx.orgId, userId: { in: userIds } }, select: { userId: true } }),
    db.poolOffer.findMany({
      where: { userId: { in: userIds }, OR: [{ matchId }, { createdAt: { gte: new Date(now.getTime() - LEDGER_LOOKBACK_MS) } }] },
      select: { userId: true, matchId: true, orgId: true, sentAt: true, createdAt: true, outcome: true, resolvedAt: true, platformJobId: true },
    }),
    db.attendance.findMany({
      where: {
        userId: { in: userIds },
        matchId: { not: matchId },
        status: { in: ["CONFIRMED", "BENCH"] },
        match: {
          status: { in: [...OPEN_MATCH_STATUSES] },
          isHistorical: false,
          date: { gte: new Date(kickoff.getTime() - DAY_MS), lte: new Date(kickoff.getTime() + DAY_MS) },
        },
      },
      select: { userId: true, match: { select: { date: true, activity: { select: { matchDurationMins: true } } } } },
    }),
    db.guestPlace.findMany({ where: { userId: { in: userIds } }, select: { userId: true, result: true, match: { select: { date: true } } } }),
    db.attendance.findMany({
      where: {
        userId: { in: userIds },
        status: "CONFIRMED",
        match: { status: "COMPLETED", date: { gte: new Date(now.getTime() - LAST_GAME_LOOKBACK_MS), lte: now } },
      },
      select: { userId: true, match: { select: { date: true } } },
    }),
  ]);

  const jobIds = offers.map((o) => o.platformJobId).filter((id): id is string => !!id);
  const jobs = jobIds.length ? await db.platformJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, sendAfter: true } }) : [];
  const sendAfter = new Map(jobs.map((j) => [j.id, j.sendAfter]));

  const rawOffers: RawOffer[] = offers.map((o) => ({
    userId: o.userId,
    matchId: o.matchId,
    orgId: o.orgId,
    sentAt: o.sentAt,
    createdAt: o.createdAt,
    outcome: o.outcome,
    resolvedAt: o.resolvedAt,
    jobSendAfter: (o.platformJobId && sendAfter.get(o.platformJobId)) || null,
  }));

  const rows = candidateRowsOf(
    matchId,
    profiles.map((p) => ({ ...p, userId: p.userId as string, phoneNumber: p.user?.phoneNumber ?? null })),
    {
      clubMemberIds: new Set(members.map((m) => m.userId)),
      onMatchIds: new Set(onMatch.map((a) => a.userId)),
      blockedIds: new Set(blocks.map((b) => b.userId)),
      offers: rawOffers,
      busy: busy.map((b) => ({ userId: b.userId, kickoff: b.match.date, durationMins: b.match.activity.matchDurationMins })),
      guestPlaces: guestPlaces.map((g) => ({ userId: g.userId, result: g.result, matchDate: g.match.date })),
      ownGames: ownGames.map((g) => ({ userId: g.userId, matchDate: g.match.date })),
    },
  );
  return { ctx, sendAt, selection: selectCandidates(ctx, rows, now, sendAt) };
}

/** "Players near you" for the organiser: the band, never who. */
export async function poolNearBand(matchId: string, opts: FindOptions = {}): Promise<PoolNearBand> {
  const found = await findPoolCandidates(matchId, opts);
  return nearBand(found.selection.eligible.length);
}

/** How many more pool DMs may go at `now` (POOL_PLATFORM_CAPS). A hint
 *  for planning; dispatch re-checks under the lock (caps.ts header). */
export async function poolPlatformRoom(now: Date = new Date()): Promise<number> {
  // A London day is at most 25 hours: 26 covers it and the last hour.
  const sent = await db.poolOffer.findMany({
    where: { sentAt: { not: null, gte: new Date(now.getTime() - 26 * HOUR_MS), lte: now } },
    select: { sentAt: true },
  });
  return platformRoom(
    sent.map((s) => s.sentAt).filter((d): d is Date => d !== null),
    now,
  );
}
