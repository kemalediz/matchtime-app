/**
 * A GUEST'S TURN-UP RECORD (slice L4, 2026-10-24). PURE.
 *
 * Read from his `GuestPlace` results across every club, partner and pool
 * guest games alike (decision log #7): `played` is a game he turned up to;
 * `no-show` and `late-cancel` are misses; `booked` (not played yet) and
 * `withdrawn` (pulled out in time) are neither.
 *
 * Matching ranks by it first (approved spec: "turn-up record ranks
 * first"). L7's reliability line and pause read the same record from here.
 *
 *   reliable    at least one game counted, at most RELIABLE_MAX_MISS_SHARE
 *               of them missed.
 *   new         no game counted yet. Ranked after a good record and before
 *               a poor one, so a newcomer still gets a chance (decision
 *               L4.5).
 *   unreliable  more misses than that.
 */
import type { GuestResult } from "./vocab";

export interface TurnUpRecord {
  played: number;
  missed: number;
}

/** At most this share of his counted games missed, and he is reliable. */
export const RELIABLE_MAX_MISS_SHARE = 0.2;

export function turnUpRecordOf(results: readonly GuestResult[]): TurnUpRecord {
  let played = 0;
  let missed = 0;
  for (const r of results) {
    if (r === "played") played++;
    else if (r === "no-show" || r === "late-cancel") missed++;
  }
  return { played, missed };
}

export type TurnUpTier = "reliable" | "new" | "unreliable";
const TIER_ORDER: Readonly<Record<TurnUpTier, number>> = { reliable: 0, new: 1, unreliable: 2 };

const missShare = (r: TurnUpRecord): number => {
  const n = r.played + r.missed;
  return n === 0 ? 0 : r.missed / n;
};

export function turnUpTier(r: TurnUpRecord): TurnUpTier {
  if (r.played + r.missed === 0) return "new";
  return missShare(r) <= RELIABLE_MAX_MISS_SHARE ? "reliable" : "unreliable";
}

/** Better record first: tier, then a smaller share missed, then more games. */
export function compareTurnUp(a: TurnUpRecord, b: TurnUpRecord): number {
  return TIER_ORDER[turnUpTier(a)] - TIER_ORDER[turnUpTier(b)] || missShare(a) - missShare(b) || b.played - a.played;
}
