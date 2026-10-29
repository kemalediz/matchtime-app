/**
 * FROM QUERY RESULTS TO MATCHING ROWS (slice L4, 2026-10-24). PURE.
 *
 * `candidates.ts` runs the queries and hands their plain results here;
 * this turns them into the `PoolMatchContext` and `PoolCandidateRow`s that
 * `matching-rules.ts` judges. Kept apart from the loader so every decision
 * about what a row MEANS (who is a member, which offer counts when, what a
 * last game is) is unit tested without a database.
 */
import type { Point } from "../club-discovery-rules";
import type { OfferLedgerEntry } from "./caps";
import type { PoolCandidateRow, PoolMatchContext } from "./matching-rules";
import { offerNeverReachedHim } from "./round-rules";
import { poolSportOfClubSport, type SportLevel } from "./sports";
import { turnUpRecordOf } from "./turn-up";
import { isOneOf, GUEST_RESULTS, POOL_OFFER_OUTCOMES, type GuestResult, type PoolOfferOutcome } from "./vocab";

const position = (v: { lat: number | null; lng: number | null } | null | undefined): Point | null =>
  v && typeof v.lat === "number" && typeof v.lng === "number" ? { lat: v.lat, lng: v.lng } : null;

export interface RawMatch {
  id: string;
  date: Date;
  status: string;
  isHistorical: boolean;
  activity: {
    orgId: string;
    matchDurationMins: number;
    venueRef: { lat: number | null; lng: number | null } | null;
    sport: { preset: string | null; name: string; playersPerTeam: number };
  };
}

export function matchContextOf(m: RawMatch, poolOpen: boolean, levels: readonly SportLevel[] | null = null): PoolMatchContext {
  return {
    matchId: m.id,
    orgId: m.activity.orgId,
    kickoff: m.date,
    durationMins: m.activity.matchDurationMins,
    matchStatus: m.status,
    isHistorical: m.isHistorical,
    venue: position(m.activity.venueRef),
    sport: poolSportOfClubSport(m.activity.sport),
    levels,
    poolOpen,
  };
}

export interface RawProfile {
  userId: string;
  status: string;
  consentAt: Date | null;
  maxMiles: number;
  areaLat: number | null;
  areaLng: number | null;
  phoneNumber: string | null;
  sports: Array<{ sport: string; formats: number[]; level: string | null }>;
  availability: Array<{ day: number; fromMin: number; toMin: number }>;
}

export interface RawOffer {
  userId: string;
  matchId: string;
  orgId: string;
  sentAt: Date | null;
  createdAt: Date;
  outcome: string | null;
  resolvedAt: Date | null;
  /** The send time its platform job is held to, while unsent. */
  jobSendAfter: Date | null;
}

export interface RawPerUser {
  /** Live non-guest memberships of the asking club. */
  clubMemberIds: ReadonlySet<string>;
  /** Anyone with an attendance row on this match. */
  onMatchIds: ReadonlySet<string>;
  /** A PoolBlock with the club, either way. */
  blockedIds: ReadonlySet<string>;
  offers: readonly RawOffer[];
  /** CONFIRMED or BENCH on another live game near kickoff. */
  busy: ReadonlyArray<{ userId: string; kickoff: Date; durationMins: number }>;
  /** Every GuestPlace of these people, any club. */
  guestPlaces: ReadonlyArray<{ userId: string; result: string; matchDate: Date }>;
  /** His own clubs' completed games he was CONFIRMED for. */
  ownGames: ReadonlyArray<{ userId: string; matchDate: Date }>;
}

/** When an offer reaches him, or will (caps.ts, decision L4.3). */
export function offerCountsAt(o: Pick<RawOffer, "sentAt" | "jobSendAfter" | "createdAt">): Date {
  return o.sentAt ?? o.jobSendAfter ?? o.createdAt;
}

export function ledgerEntryOf(o: RawOffer): OfferLedgerEntry {
  return {
    orgId: o.orgId,
    at: offerCountsAt(o),
    outcome: isOneOf(POOL_OFFER_OUTCOMES, o.outcome) ? (o.outcome as PoolOfferOutcome) : null,
    resolvedAt: o.resolvedAt,
  };
}

export function candidateRowsOf(matchId: string, profiles: readonly RawProfile[], per: RawPerUser): PoolCandidateRow[] {
  const groupBy = <T extends { userId: string }>(xs: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(x.userId, [...(m.get(x.userId) ?? []), x]);
    return m;
  };
  const offers = groupBy(per.offers);
  const busy = groupBy(per.busy);
  const places = groupBy(per.guestPlaces);
  const own = groupBy(per.ownGames);

  return profiles.map((p) => {
    const mine = offers.get(p.userId) ?? [];
    const results = (places.get(p.userId) ?? []).map((g) => g.result).filter((r): r is GuestResult => isOneOf(GUEST_RESULTS, r));
    const lastTimes = [
      ...(places.get(p.userId) ?? []).filter((g) => g.result === "played").map((g) => g.matchDate.getTime()),
      ...(own.get(p.userId) ?? []).map((g) => g.matchDate.getTime()),
    ];
    return {
      userId: p.userId,
      status: p.status,
      consentAt: p.consentAt,
      hasPhone: !!p.phoneNumber,
      maxMiles: p.maxMiles,
      area: position({ lat: p.areaLat, lng: p.areaLng }),
      sports: p.sports.map((s) => ({ sport: s.sport, formats: s.formats, level: s.level })),
      availability: p.availability.map((a) => ({ day: a.day, fromMin: a.fromMin, toMin: a.toMin })),
      isClubMember: per.clubMemberIds.has(p.userId),
      onThisMatch: per.onMatchIds.has(p.userId),
      blocked: per.blockedIds.has(p.userId),
      // One per match ever, for offers that reached him (or may still):
      // one cancelled before its DM went does not count.
      alreadyOffered: mine.some((o) => o.matchId === matchId && !offerNeverReachedHim(o)),
      busyGames: (busy.get(p.userId) ?? []).map((b) => ({ kickoff: b.kickoff, durationMins: b.durationMins })),
      record: turnUpRecordOf(results),
      lastGameAt: lastTimes.length > 0 ? new Date(Math.max(...lastTimes)) : null,
      ledger: mine.map(ledgerEntryOf),
    };
  });
}
