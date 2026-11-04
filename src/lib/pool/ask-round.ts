/**
 * ONE PRESS, ONE ROUND, PARTNERS AND THE POOL (slice L5a, 2026-10-24). The
 * organiser's one-tap approval on the match page: the ticked partner clubs
 * (`requestPartnerRound`, unchanged) and, when ticked, the MatchTime player
 * pool (`requestPoolAsk`), sharing the round's id and its number. With no
 * partner asked (none ticked, or every one refused) the pool ask is a
 * round of its own. Either way its first offers go at once: MatchTime asks
 * exactly what the organiser ticked, now (Kemal, 2026-10-29; only the
 * automatic ask waits, `round-rules.ts` `poolWaitsForPartners`).
 */
import { db } from "../db";
import { requestPartnerRound, type RoundResult } from "../partner-ask";
import { requestPoolAsk, type PoolAskResult } from "./round";
import { VOICE_SELECT, clubSpeaks, voiceFactsOfRow } from "../club-voice";

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
}): Promise<{ partner: RoundResult | null; pool: PoolAskResult | null; clubQuiet?: true }> {
  const now = args.now ?? new Date();
  // The one rule (club summary B6, `club-voice.ts`): partner clubs and the
  // pool are asked on the club's behalf and answer back to it, so only a
  // club MatchTime speaks for asks anyone (not a muted, dormant, paused,
  // unapproved or setting-up one). The press is told why.
  const club = await db.organisation.findUnique({ where: { id: args.orgId }, select: VOICE_SELECT });
  if (!club || !clubSpeaks(voiceFactsOfRow(club))) return { partner: null, pool: null, clubQuiet: true };
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
