/**
 * A POOL ROUND'S WAVES AND SEND TIMES (slice L4, 2026-10-24). PURE.
 *
 * Approved spec, "Limits": a round asks up to 8 pool players, about 4
 * first, the rest only if places are still open. The numbers are rules.ts
 * `POOL_ROUND`. No night hold (Kemal, 2026-10-29): a wave goes when it is
 * due, at any hour.
 *
 *   firstWaveSize  about 4 (`POOL_ROUND.firstWave`), never fewer than the
 *                  places asked for, never more than `maxOffers`
 *                  (decision L4.4).
 *   secondWave     the rest (`maxOffers` minus the first wave), sent
 *                  `secondWaveAfterMins` after the first, only while places
 *                  are open and before the club's cut-off. Its players are
 *                  chosen THEN, by the same filters and caps, not reserved
 *                  at the first wave: a person may have been offered
 *                  another game meanwhile.
 *   offerExpiresAt `offerTtlHours` after it was sent, or the cut-off,
 *                  whichever comes first (plan 4.3).
 *
 * The cut-off is the partner ask's (`askWindows(kickoff, cutoffHours).postBy`
 * in partner-ask-rules.ts); the caller passes it.
 */
import { POOL_ROUND } from "./rules";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/** How many to offer in the first wave, from `candidates` eligible players. */
export function firstWaveSize(candidates: number, places: number): number {
  if (places <= 0 || candidates <= 0) return 0;
  return Math.min(candidates, POOL_ROUND.maxOffers, Math.max(POOL_ROUND.firstWave, places));
}

export type SecondWave =
  | { kind: "send"; size: number }
  | { kind: "wait"; at: Date }
  | { kind: "none"; reason: "filled" | "round-full" | "too-late" };

/** The second wave's state at `now`. */
export function secondWave(a: { wave1SentAt: Date; wave1Count: number; placesOpen: number; cutoff: Date; now: Date }): SecondWave {
  if (a.placesOpen <= 0) return { kind: "none", reason: "filled" };
  const size = POOL_ROUND.maxOffers - a.wave1Count;
  if (size <= 0) return { kind: "none", reason: "round-full" };
  const due = new Date(a.wave1SentAt.getTime() + POOL_ROUND.secondWaveAfterMins * MIN_MS);
  if (due.getTime() >= a.cutoff.getTime()) return { kind: "none", reason: "too-late" };
  if (a.now.getTime() < due.getTime()) return { kind: "wait", at: due };
  return { kind: "send", size };
}

/** When an offer sent at `sentAt` stops being open. */
export function offerExpiresAt(sentAt: Date, cutoff: Date): Date {
  const ttl = sentAt.getTime() + POOL_ROUND.offerTtlHours * HOUR_MS;
  return new Date(Math.min(ttl, cutoff.getTime()));
}
