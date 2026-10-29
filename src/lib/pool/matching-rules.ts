/**
 * WHO IS OFFERED A PLACE: the pool's matching rules (slice L4, 2026-10-24).
 * PURE: no database, no model, no clock of its own. The loader is
 * `candidates.ts`; it hands plain rows here.
 *
 * Approved spec, "Matching": plain code: sport, distance, format where it
 * applies, day AND hours, not already in that club, turn-up record ranks
 * first. Plan 4.2 adds the rest. Two levels:
 *
 * THE MATCH (`matchGate`): the global switch and the club's flag
 * (`flags.ts` `poolOffersOpenForClub`, resolved by the loader into
 * `poolOpen`); a live, non-historical match not yet kicked off; a venue
 * with coordinates (decision L4.2: no town fallback, the organiser is asked
 * to confirm the venue instead, as plan 4.2 says); a club sport the pool's
 * catalogue has (`sports.ts` `poolSportOfClubSport`).
 *
 * THE PERSON (`candidateExclusion`), checked in MATCH_EXCLUSION_ORDER, the
 * first failure reported:
 *   not-active       profile not "active" (paused, stopped, pending).
 *   no-consent       no consent on record.
 *   no-phone         nothing to message.
 *   sport            he does not play the club's sport. An "other" sport he
 *                    typed in never matches (a club sport the catalogue
 *                    lacks is closed at the gate).
 *   format           only where the sport has formats. His formats empty
 *                    means "any". The club's format unknown (a custom sport
 *                    whose players per team is not a catalogue format):
 *                    only an any-format player (decision L4.7).
 *   level            only when the ask names levels: his catalogue level
 *                    must be one of them; none, or only his own words, is
 *                    out (decision L4.8). Never ranks.
 *   too-far          the venue is beyond his travel distance from his
 *                    postcode area's centre (haversine, capped at the
 *                    largest travel option, 10 miles). His area is the
 *                    only place measured from (`PoolArea`, rules.ts).
 *   not-available    his day-and-hours ranges do not cover kickoff to full
 *                    time (`availability.ts`).
 *   club-member      a live, non-guest member of the asking club.
 *   on-match         already on this match (any attendance row, a dropped
 *                    one included: he has answered for it).
 *   blocked          a PoolBlock between him and the club, either way.
 *   already-offered  an offer for this match exists (one per match ever).
 *   busy             CONFIRMED or BENCH on another live game that overlaps,
 *                    an hour of travel either side (`gamesOverlap`,
 *                    partner-ask-rules.ts, the partner guests' rule).
 *   day-cap, week-cap, decline-cooldown   `caps.ts`, judged at the send time.
 *
 * THE RANKING (`rankCandidates`): turn-up record (`turn-up.ts`), then the
 * most recent game he played (more recent first; none last), then distance
 * (nearer first), then user id: a total order, so the same input always
 * gives the same list.
 */
import { nearestMiles, type Point } from "../club-discovery-rules";
import { gamesOverlap } from "../partner-ask-rules";
import { availableFor } from "./availability";
import { playerCapRefusal, type OfferLedgerEntry } from "./caps";
import { POOL_TRAVEL_MILES, type AvailabilityRange } from "./rules";
import { sportHasFormats, type PoolSportChoiceKey, type PoolSportKey, type SportLevel } from "./sports";
import { compareTurnUp, type TurnUpRecord } from "./turn-up";
import type { PoolProfileStatus } from "./vocab";

/** Match statuses a pool offer may be made for. */
export const OPEN_MATCH_STATUSES = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

/** The farthest anyone travels, whatever a row says. */
const MAX_TRAVEL_MILES = Math.max(...POOL_TRAVEL_MILES);
/** Float slack on "exactly his travel distance" (about 2 mm). */
const MILES_EPSILON = 1e-6;

export interface PoolMatchContext {
  matchId: string;
  orgId: string;
  kickoff: Date;
  durationMins: number;
  matchStatus: string;
  isHistorical: boolean;
  /** The match venue's position; null when it has none. */
  venue: Point | null;
  /** The club's sport in the catalogue (`poolSportOfClubSport`). */
  sport: { sport: PoolSportKey; format: number | null } | null;
  /** The levels the ask wants; null or empty: any. */
  levels: readonly SportLevel[] | null;
  /** The global switch AND the club's flag (`poolOffersOpenForClub`). */
  poolOpen: boolean;
}

export interface PoolCandidateRow {
  userId: string;
  status: PoolProfileStatus | string;
  consentAt: Date | null;
  hasPhone: boolean;
  maxMiles: number;
  /** His postcode area's centre point. */
  area: Point | null;
  sports: Array<{ sport: PoolSportChoiceKey | string; formats: number[]; level: SportLevel | string | null }>;
  availability: AvailabilityRange[];
  isClubMember: boolean;
  onThisMatch: boolean;
  blocked: boolean;
  alreadyOffered: boolean;
  /** His CONFIRMED or BENCH games elsewhere around that time. */
  busyGames: Array<{ kickoff: Date; durationMins: number }>;
  record: TurnUpRecord;
  lastGameAt: Date | null;
  /** His earlier offers, for the caps. */
  ledger: OfferLedgerEntry[];
}

export type MatchGateRefusal = "pool-closed" | "match-not-open" | "no-venue" | "no-sport";

export const MATCH_EXCLUSION_ORDER = [
  "not-active",
  "no-consent",
  "no-phone",
  "sport",
  "format",
  "level",
  "too-far",
  "not-available",
  "club-member",
  "on-match",
  "blocked",
  "already-offered",
  "busy",
  "day-cap",
  "week-cap",
  "decline-cooldown",
] as const satisfies ReadonlyArray<string>;
export type CandidateExclusion = (typeof MATCH_EXCLUSION_ORDER)[number];

export function matchGate(ctx: PoolMatchContext, now: Date): MatchGateRefusal | null {
  if (!ctx.poolOpen) return "pool-closed";
  if (!(OPEN_MATCH_STATUSES as readonly string[]).includes(ctx.matchStatus) || ctx.isHistorical || ctx.kickoff.getTime() <= now.getTime()) {
    return "match-not-open";
  }
  if (!ctx.venue) return "no-venue";
  if (!ctx.sport) return "no-sport";
  return null;
}

/** Miles from the venue to his postcode area's centre; null with no area. */
export function distanceToVenue(venue: Point, area: Point | null): number | null {
  return area ? (nearestMiles([venue], [area])?.miles ?? null) : null;
}

export function withinTravel(miles: number, maxMiles: number): boolean {
  return miles <= Math.min(maxMiles, MAX_TRAVEL_MILES) + MILES_EPSILON;
}

/**
 * Why this person may not be offered this match at `sendAt`, or null.
 * The caller has already passed `matchGate` (venue and sport are set).
 */
export function candidateExclusion(ctx: PoolMatchContext, row: PoolCandidateRow, sendAt: Date): CandidateExclusion | null {
  if (row.status !== "active") return "not-active";
  if (!row.consentAt) return "no-consent";
  if (!row.hasPhone) return "no-phone";

  const want = ctx.sport;
  const plays = want ? row.sports.find((s) => s.sport === want.sport) : undefined;
  if (!want || !plays) return "sport";
  if (sportHasFormats(want.sport) && plays.formats.length > 0 && (want.format === null || !plays.formats.includes(want.format))) {
    return "format";
  }
  if (ctx.levels && ctx.levels.length > 0 && !(plays.level && (ctx.levels as readonly string[]).includes(plays.level))) return "level";

  const miles = ctx.venue ? distanceToVenue(ctx.venue, row.area) : null;
  if (miles === null || !withinTravel(miles, row.maxMiles)) return "too-far";
  if (!availableFor(row.availability, ctx.kickoff, ctx.durationMins)) return "not-available";

  if (row.isClubMember) return "club-member";
  if (row.onThisMatch) return "on-match";
  if (row.blocked) return "blocked";
  if (row.alreadyOffered) return "already-offered";
  const game = { kickoff: ctx.kickoff, durationMins: ctx.durationMins };
  if (row.busyGames.some((g) => gamesOverlap(game, g))) return "busy";

  return playerCapRefusal(row.ledger, ctx.orgId, sendAt);
}

export interface RankInput {
  userId: string;
  record: TurnUpRecord;
  lastGameAt: Date | null;
  distanceMiles: number;
}

/** A new list, best first (see the header). */
export function rankCandidates<T extends RankInput>(rows: readonly T[]): T[] {
  const last = (r: RankInput) => r.lastGameAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return [...rows].sort(
    (a, b) =>
      compareTurnUp(a.record, b.record) ||
      (last(b) > last(a) ? 1 : last(b) < last(a) ? -1 : 0) ||
      a.distanceMiles - b.distanceMiles ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
}

export interface EligibleCandidate extends RankInput {
  row: PoolCandidateRow;
}

export interface Selection {
  gate: MatchGateRefusal | null;
  /** Ranked, best first. */
  eligible: EligibleCandidate[];
  /** How many were left out, by reason (only reasons that occurred). */
  excluded: Partial<Record<CandidateExclusion, number>>;
}

/**
 * The match gate at `now`, then every person's filters and caps at
 * `sendAt` (the moment the offer would reach him; now, since the pool has
 * no night hold, 2026-10-29),
 * then the ranking.
 */
export function selectCandidates(ctx: PoolMatchContext, rows: readonly PoolCandidateRow[], now: Date, sendAt: Date = now): Selection {
  const gate = matchGate(ctx, now);
  if (gate) return { gate, eligible: [], excluded: {} };
  const eligible: EligibleCandidate[] = [];
  const excluded: Partial<Record<CandidateExclusion, number>> = {};
  for (const row of rows) {
    const why = candidateExclusion(ctx, row, sendAt);
    if (why) {
      excluded[why] = (excluded[why] ?? 0) + 1;
      continue;
    }
    const distanceMiles = distanceToVenue(ctx.venue as Point, row.area) as number;
    eligible.push({ userId: row.userId, record: row.record, lastGameAt: row.lastGameAt, distanceMiles, row });
  }
  return { gate: null, eligible: rankCandidates(eligible), excluded };
}
