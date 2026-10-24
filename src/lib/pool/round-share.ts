/**
 * THE POOL'S SHARE OF A ROUND (slice L5a, 2026-10-24). Read only.
 *
 * A round can span partner clubs and the pool (plan section 7: `PoolAsk`
 * shares `PartnerAsk.roundId`). Its number is for the whole round, and the
 * round is filled when the guests with a place, from ANY of its asks, reach
 * it. `partner-ask-round.ts` (`loadRoundFill`, the one definition of a
 * round's fill) asks this module for the pool's part: the number the pool
 * ask carries and the people who accepted one of its offers. The pool's
 * tables stay readable only by pool code (`__tests__/source-guard.test.ts`).
 *
 * `roundKey` is the round id, or the ask's own id for a round of one.
 * Never throws: a read that fails leaves the round counted on its partner
 * asks alone, as before the pool existed.
 */
import { db } from "../db";

export interface PoolRoundShare {
  places: number;
  /** Who accepted an offer of the round's pool ask. */
  userIds: string[];
}

export async function poolRoundShare(matchId: string, roundKey: string): Promise<PoolRoundShare | null> {
  try {
    const asks = await db.poolAsk.findMany({
      where: { matchId, OR: [{ roundId: roundKey }, { id: roundKey }] },
      select: { id: true, places: true },
    });
    if (!asks || asks.length === 0) return null;
    const accepted = await db.poolOffer.findMany({
      where: { poolAskId: { in: asks.map((a) => a.id) }, outcome: "accepted" },
      select: { userId: true },
    });
    return { places: Math.max(...asks.map((a) => a.places)), userIds: [...new Set((accepted ?? []).map((o) => o.userId))] };
  } catch (err) {
    console.error(`[pool] round ${roundKey}: the pool's share was not read:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}
