/**
 * ONE PRESS, ONE ROUND, PARTNERS AND THE POOL (slice L5a, 2026-10-24). The
 * organiser's one-tap approval on the match page: the ticked partner clubs
 * (`requestPartnerRound`, unchanged) and, when ticked, the MatchTime player
 * pool (`requestPoolAsk`), sharing the round's id and its number. With no
 * partner asked (none ticked, or every one refused) the pool ask is a
 * round of its own and its first offers go at once; otherwise an hour
 * after the partners (`round-rules.ts` `wave1DueAt`).
 */
import { requestPartnerRound, type RoundResult } from "../partner-ask";
import { requestPoolAsk, type PoolAskResult } from "./round";

type Env = Record<string, string | undefined>;

export async function requestAskRound(args: {
  orgId: string;
  matchId: string;
  partnershipIds: string[];
  pool: boolean;
  places: number;
  userId: string;
  now?: Date;
  poolEnv?: Env;
}): Promise<{ partner: RoundResult | null; pool: PoolAskResult | null }> {
  const now = args.now ?? new Date();
  const partner =
    args.partnershipIds.length > 0
      ? await requestPartnerRound({
          askerOrgId: args.orgId,
          matchId: args.matchId,
          partnershipIds: args.partnershipIds,
          places: args.places,
          requestedByUserId: args.userId,
          via: "button",
          now,
        })
      : null;
  const pool = args.pool
    ? await requestPoolAsk({
        orgId: args.orgId,
        matchId: args.matchId,
        places: args.places,
        roundId: partner && partner.asked > 0 ? partner.roundId : null,
        approvedByUserId: args.userId,
        via: "page",
        now,
        env: args.poolEnv,
      })
    : null;
  // The exclusion counts are for the chat's "nobody new" reply only; the
  // match page's answer keeps its shape.
  if (pool && !pool.ok && pool.excluded) delete pool.excluded;
  return { partner, pool };
}
