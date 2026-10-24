/**
 * THE AUTOMATIC ASK INCLUDES THE POOL: THE ADAPTER (slice L9, 2026-10-24).
 * Thin I/O around the pure rule (`auto-ask-rules.ts`). Called once per
 * match by the automatic partner ask (`partner-ask.ts`
 * `sweepAutoPartnerAsks`, every due-posts poll), right after it asked the
 * partners it was going to ask.
 *
 * The ask itself is the organiser tap's own function, `requestPoolAsk`
 * (`round.ts`), with `via: "auto"` standing in for the tap: every rule of
 * a tap (the match gate, the cut-off, the club's 1-open and 3-a-week
 * caps, nobody near), and everything after it (partners first, the waves,
 * each person's caps, the platform cap, quiet hours, both switches at queue
 * and at dispatch) is that path's, unchanged. Nothing here sends an offer.
 *
 * The organisers hear one line when the pool was asked (the automatic
 * partner ask tells them the same way). Logs carry ids only. Never throws.
 */
import { db } from "../db";
import { sendAdminNotice } from "../admin-channel";
import { dayCommaTimeLabel } from "../i18n/dates";
import { poolCopy } from "../i18n/pool-offer";
import { OPEN_ASK_STATUSES } from "../partner-ask-rules";
import { poolAutoAskDue, poolAutoRound } from "./auto-ask-rules";
import { poolOffersOpenForClub } from "./flags";
import { requestPoolAsk, type PoolAskResult } from "./round";

type Env = Record<string, string | undefined>;

export interface PoolAutoAskClubState {
  /** The global switch AND the club's flag. */
  poolOpen: boolean;
  poolAutoAsk: boolean;
  language: string | null;
}

/** The club's pool switches, read once per sweep. */
export async function poolAutoAskClub(orgId: string, env?: Env): Promise<PoolAutoAskClubState> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { featurePlayerPool: true, poolAutoAsk: true, language: true } });
  if (!org) return { poolOpen: false, poolAutoAsk: false, language: null };
  return { poolOpen: poolOffersOpenForClub(org, env), poolAutoAsk: org.poolAutoAsk === true, language: org.language ?? null };
}

/** The newest partner round still open on the match, with its number:
 *  a pool ask joins it, so the partners have their hour first. Also the
 *  organisers' ask in HQ (L10, `pool-ask-words.ts`). */
export async function openPartnerRoundOf(orgId: string, matchId: string): Promise<{ roundId: string; places: number } | null> {
  const open = await db.partnerAsk.findFirst({
    where: { matchId, askerOrgId: orgId, status: { in: [...OPEN_ASK_STATUSES] }, roundId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { roundId: true, places: true },
  });
  return open?.roundId ? { roundId: open.roundId, places: open.places } : null;
}

export async function autoAskPool(args: {
  orgId: string;
  match: { id: string; date: Date };
  now: Date;
  askAt: Date;
  postBy: Date;
  placesOpen: number;
  waitingCount: number;
  hasPartners: boolean;
  partnersWhen: string;
  /** The round id this pass's partner asks share, when any was made. */
  askedNowRoundId: string | null;
  club: PoolAutoAskClubState;
  env?: Env;
}): Promise<PoolAskResult | null> {
  try {
    const rule = {
      poolOpen: args.club.poolOpen,
      poolAutoAsk: args.club.poolAutoAsk,
      hasPartners: args.hasPartners,
      partnersWhen: args.partnersWhen,
      now: args.now,
      askAt: args.askAt,
      postBy: args.postBy,
      placesOpen: args.placesOpen,
      waitingCount: args.waitingCount,
    };
    // The club-level and time checks first: most polls stop here unread.
    if (!poolAutoAskDue({ ...rule, poolAskedBefore: false })) return null;
    const asked = (await db.poolAsk.count({ where: { orgId: args.orgId, matchId: args.match.id } })) > 0;
    if (!poolAutoAskDue({ ...rule, poolAskedBefore: asked })) return null;

    const round = poolAutoRound({
      askedNowRoundId: args.askedNowRoundId,
      openRound: args.askedNowRoundId ? null : await openPartnerRoundOf(args.orgId, args.match.id),
      placesOpen: args.placesOpen,
    });
    const r = await requestPoolAsk({
      orgId: args.orgId,
      matchId: args.match.id,
      places: round.places,
      roundId: round.roundId,
      approvedByUserId: null,
      via: "auto",
      now: args.now,
      env: args.env,
    });
    if (!r.ok) return r;
    const lang = args.club.language;
    await sendAdminNotice({
      orgId: args.orgId,
      now: args.now,
      holdOvernight: false,
      text: poolCopy(lang).notice_auto({ day: dayCommaTimeLabel(lang, args.match.date), partnersFirst: round.roundId !== null && !r.waveSent }),
    });
    return r;
  } catch (err) {
    console.error(`[pool] auto ask for match ${args.match.id} by ${args.orgId} failed:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}
