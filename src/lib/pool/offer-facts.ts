/**
 * THE FACTS AN OFFER STATES, LOADED (slice L5a, 2026-10-24). Thin I/O for
 * the pure composer `offer-copy.ts`: everything here is data MatchTime
 * already has about the CLUB and the GAME (plan 5.2's table), never about
 * a person. The distance is the one per-person fact; the round runner
 * adds it from the candidate it picked.
 *
 *   club, venue (name, address, map link; the activity's own venue text
 *   when no venue is linked), kickoff and length, sport and format
 *   (`sports.ts`), play style, club size (live ordinary members, guests
 *   never counted) and how often it played in the last 8 weeks, fee.
 *
 * FEE. The match's per-player fee, else, in a week of a running month, the
 * club's PAYG price (what a guest is charged there), else the activity's
 * (unless the fee is a total split between the players). "Free" only when the club takes no
 * fee at all: no per-player fee, no split total, and neither payment
 * collection nor tracking on. Anything else unknown: the line is left out.
 */
import { db } from "../db";
import { feeLabel } from "../partner-ask";
import { guestPaygPence } from "../monthly-week-asks";
import { guestFeePounds } from "../monthly-week-asks-rules";
import { venueMapUrl } from "../venue-location-rules";
import type { PoolFee, PoolOfferFacts } from "./offer-copy";
import { poolSportOfClubSport } from "./sports";
import { isOneOf, PLAY_STYLES, type PlayStyle } from "./vocab";

const DAY_MS = 24 * 3600_000;
/** "How often it plays": games in this many days before now. */
export const REGULARITY_WINDOW_DAYS = 56;

export function poolFeeOf(m: {
  matchFee: number | null;
  activityFee: number | null;
  feeSplitTotal: boolean;
  paymentsOn: boolean;
  /** The club's PAYG price, in a week of a running month only: a pool
   *  guest there pays per game like any PAYG player. */
  monthlyPaygPence?: number | null;
}): PoolFee {
  const perPlayer = guestFeePounds({ matchFee: m.matchFee, activityFee: m.activityFee, feeSplitTotal: m.feeSplitTotal, monthlyPaygPence: m.monthlyPaygPence ?? null });
  const label = feeLabel(perPlayer);
  if (label) return { kind: "amount", amount: label };
  if (m.feeSplitTotal || m.paymentsOn) return null;
  return { kind: "free" };
}

export type MatchOfferFacts = Omit<PoolOfferFacts, "distanceMiles" | "places">;

const GAME_SELECT = {
  date: true,
  feePerPlayer: true,
  activity: {
    select: {
      orgId: true,
      venue: true,
      matchDurationMins: true,
      feePerPlayer: true,
      feeSplitTotal: true,
      sport: { select: { preset: true, name: true, playersPerTeam: true } },
      venueRef: { select: { name: true, formattedAddress: true, lat: true, lng: true, placeId: true } },
      org: { select: { name: true, language: true, playStyle: true, paymentCollectionEnabled: true, paymentTrackingEnabled: true } },
    },
  },
} as const;

type GameRow = NonNullable<Awaited<ReturnType<typeof loadGameRow>>>;

function loadGameRow(matchId: string) {
  return db.match.findUnique({ where: { id: matchId }, select: GAME_SELECT });
}

/** The venue's name as an offer shows it, and the fee. One rule for the
 *  pool offer and the recruit invite DM. */
function venueAndFeeOf(match: GameRow, monthlyPaygPence: number | null): { venueName: string; fee: PoolFee } {
  const a = match.activity;
  return {
    venueName: a.venueRef?.name ?? a.venue,
    fee: poolFeeOf({
      matchFee: match.feePerPlayer,
      activityFee: a.feePerPlayer,
      feeSplitTotal: a.feeSplitTotal,
      paymentsOn: a.org.paymentCollectionEnabled || a.org.paymentTrackingEnabled,
      monthlyPaygPence,
    }),
  };
}

/**
 * The club, venue and fee of any game, whatever its sport (the recruit
 * invite DM, 2026-11-09): the same venue name and fee an offer states.
 * Null when the match does not exist.
 */
export async function loadMatchVenueAndFee(matchId: string): Promise<{ club: string; venueName: string; fee: PoolFee } | null> {
  const match = await loadGameRow(matchId);
  if (!match) return null;
  return { club: match.activity.org.name, ...venueAndFeeOf(match, await guestPaygPence(matchId)) };
}

/** The game's facts, or null when the match or its sport is not one the
 *  pool can offer. */
export async function loadMatchOfferFacts(matchId: string, now: Date = new Date()): Promise<(MatchOfferFacts & { orgId: string; language: string }) | null> {
  const match = await loadGameRow(matchId);
  if (!match) return null;
  const a = match.activity;
  const sport = poolSportOfClubSport(a.sport);
  if (!sport) return null;
  const [members, games, monthlyPaygPence] = await Promise.all([
    db.membership.count({ where: { orgId: a.orgId, leftAt: null, guestMatchId: null } }),
    db.match.count({
      where: { activity: { orgId: a.orgId }, status: "COMPLETED", date: { gte: new Date(now.getTime() - REGULARITY_WINDOW_DAYS * DAY_MS), lte: now } },
    }),
    guestPaygPence(matchId),
  ]);
  const { venueName, fee } = venueAndFeeOf(match, monthlyPaygPence);
  return {
    orgId: a.orgId,
    language: a.org.language,
    club: a.org.name,
    sport: sport.sport,
    format: sport.format,
    kickoff: match.date,
    durationMins: a.matchDurationMins,
    venueName,
    address: a.venueRef?.formattedAddress ?? null,
    mapUrl: a.venueRef ? venueMapUrl(a.venueRef) : null,
    playStyle: isOneOf(PLAY_STYLES, a.org.playStyle) ? (a.org.playStyle as PlayStyle) : null,
    members,
    gamesLast8Weeks: games,
    fee,
  };
}
