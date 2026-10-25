/**
 * THE TAP-YES LINK (slice L5a, 2026-10-24): what `/play/offer/<token>`
 * shows and does. Thin I/O around `round-rules.ts` (`acceptRefusal`,
 * `pullOutResult`), `accept-rules.ts` (the page state, the record line)
 * and the one guest writer (`partner-guest.ts` `placePoolGuest`).
 *
 *   loadOfferPage  the facts and the state, in HIS language. Reading the
 *                  page changes nothing, and it carries NO sign-in link:
 *                  the offer link may be forwarded to a friend ("look at
 *                  this game"), so the page links to /play/manage plainly
 *                  (his own session needed); the DMs carry his signed one.
 *   acceptOffer    re-check, claim the offer (compare-and-set, so a double
 *                  tap writes once), place him under the club's rule and
 *                  the round's number (the per-match lock), then: the
 *                  organisers are told (first name, last initial, the
 *                  turn-up line; never a number), he gets the match
 *                  details by DM, and a round he filled closes now, its
 *                  partner asks too. Lost the race: "filled", nothing else.
 *   declineOffer   "No thanks": that club cannot offer him again for 14
 *                  days (`caps.ts`, decision cooldown).
 *   pullOutOfOffer he gives the place back: the normal drop flow, the
 *                  organisers told, his guest place marked in time or late.
 *
 * WHO MAY ANSWER (review of #400, M2): the three answers change HIS record,
 * so the page's actions run them only for the holder (`isOfferHolder`:
 * signed in as him, or his last 4 digits proved on this phone,
 * `checkOfferDigits`); a forwarded link shows the game's facts only. A
 * reply in his own words (L6, `reply.ts`) runs the SAME three functions,
 * `via: "words"`, only for a DM from the number the offer went to.
 */
import { db } from "../db";
import { appUrl } from "../app-url";
import { sendAdminNotice } from "../admin-channel";
import { dayCommaTimeLabel } from "../i18n/dates";
import { normaliseLang, type Lang } from "../i18n/lang";
import { poolCopy } from "../i18n/pool-offer";
import { askWindows } from "../partner-ask-rules";
import { loadPartnerAskSettings } from "../club-partnership";
import { placePoolGuest, withdrawPoolGuest } from "../partner-guest";
import { queuePlatformDm } from "../platform-jobs";
import { offerPageState, organiserRecordOf, type OfferPageState } from "./accept-rules";
import { buildPoolManageLink } from "./links";
import { OPEN_MATCH_STATUSES } from "./matching-rules";
import { loadMatchOfferFacts, type MatchOfferFacts } from "./offer-facts";
import { poolOrganiserNotice, poolPlacedText, shortDisplayName } from "./offer-copy";
import { poolOfferPath } from "./offer-token";
import { closePoolAsk, poolAskFill } from "./round";
import { acceptRefusal, pullOutResult } from "./round-rules";
import { poolOffersOpenForClub } from "./flags";
import { digitsAnswer, digitsMatch, type DigitsAnswer } from "./offer-proof-rules";
import { isPoolOfferProof } from "./offer-token";
import { stampIfOnItsWay } from "./dispatch";
import { broughtByForFirstGame } from "./referrals";
import { poolReferralCopy } from "../i18n/pool-referral";

type Env = Record<string, string | undefined>;

const OFFER_SELECT = {
  id: true,
  poolAskId: true,
  matchId: true,
  orgId: true,
  userId: true,
  distanceMiles: true,
  sentAt: true,
  expiresAt: true,
  outcome: true,
  ask: {
    select: {
      id: true,
      roundId: true,
      places: true,
      status: true,
      org: { select: { name: true, language: true, benchPickMode: true, featurePlayerPool: true } },
      match: { select: { date: true, status: true, isHistorical: true } },
    },
  },
} as const;

async function loadOffer(offerId: string) {
  return db.poolOffer.findUnique({ where: { id: offerId }, select: OFFER_SELECT });
}
type LoadedOffer = NonNullable<Awaited<ReturnType<typeof loadOffer>>>;

const matchLiveOf = (m: { status: string; isHistorical: boolean }) => (OPEN_MATCH_STATUSES as readonly string[]).includes(m.status) && !m.isHistorical;

async function profileOf(userId: string) {
  return db.poolProfile.findUnique({ where: { userId }, select: { status: true, language: true, displayName: true, user: { select: { phoneNumber: true } } } });
}

async function stateOf(o: LoadedOffer, profileActive: boolean, now: Date, env?: Env): Promise<OfferPageState> {
  const [place, row] = o.outcome === "accepted"
    ? await Promise.all([
        db.guestPlace.findUnique({ where: { matchId_userId: { matchId: o.matchId, userId: o.userId } }, select: { result: true } }),
        db.attendance.findUnique({ where: { matchId_userId: { matchId: o.matchId, userId: o.userId } }, select: { status: true } }),
      ])
    : [null, null];
  const state = offerPageState({
    outcome: o.outcome,
    refusal: o.outcome ? null : refusalOf(o, profileActive, now, env),
    guestResult: place?.result ?? null,
    attendanceStatus: row?.status ?? null,
    matchLive: matchLiveOf(o.ask.match),
    askStatus: o.ask.status,
  });
  // Open, but he is this club's live guest for ANOTHER game: one guest
  // place per club at a time (review of #400, minor 6).
  if (state === "open") {
    const mem = await db.membership.findUnique({ where: { userId_orgId: { userId: o.userId, orgId: o.orgId } }, select: { leftAt: true, guestMatchId: true } });
    if (mem && !mem.leftAt && mem.guestMatchId && mem.guestMatchId !== o.matchId) return "busy";
  }
  return state;
}

function refusalOf(o: LoadedOffer, profileActive: boolean, now: Date, env?: Env) {
  return acceptRefusal({
    poolOpen: poolOffersOpenForClub(o.ask.org, env),
    outcome: o.outcome,
    sentAt: o.sentAt,
    expiresAt: o.expiresAt,
    askStatus: o.ask.status,
    matchLive: matchLiveOf(o.ask.match),
    kickoff: o.ask.match.date,
    profileActive,
    now,
  });
}

export interface OfferPage {
  lang: Lang;
  state: OfferPageState;
  /** The game's facts; `distanceMiles` only once it is proved to be him. */
  facts: (MatchOfferFacts & { places: number; distanceMiles: number | null }) | null;
  /** He proved it is him (signed in as him, or his digits on this phone). */
  verified: boolean;
}

/** Is this request HIS (review of #400, M2; `offer-proof-rules.ts`)? */
export async function isOfferHolder(offerId: string, viewer: { sessionUserId: string | null; proof: string | null }): Promise<boolean> {
  if (isPoolOfferProof(offerId, viewer.proof)) return true;
  if (!viewer.sessionUserId) return false;
  const o = await db.poolOffer.findUnique({ where: { id: offerId }, select: { userId: true } });
  return o?.userId === viewer.sessionUserId;
}

/** His last 4 digits, typed on the page. A wrong one is recorded; five in a
 *  day lock the digits for this offer. */
export async function checkOfferDigits(offerId: string, digits: unknown, now: Date = new Date()): Promise<DigitsAnswer> {
  const o = await db.poolOffer.findUnique({ where: { id: offerId }, select: { userId: true } });
  if (!o) return "wrong";
  const user = await db.user.findUnique({ where: { id: o.userId }, select: { phoneNumber: true } });
  // The count and the record in ONE transaction under a lock per offer
  // (second review of #400, item 1): 50 guesses at once are judged one by
  // one, so the lock closes after the fifth wrong one, not after all 50.
  const answer = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pool-verify:${offerId}`}))`;
      const wrongToday = await tx.poolAttempt.count({ where: { kind: "offer-verify", key: offerId, createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } } });
      const a = digitsAnswer({ match: digitsMatch(user?.phoneNumber, digits), wrongToday });
      if (a === "wrong") await tx.poolAttempt.create({ data: { kind: "offer-verify", key: offerId, result: "wrong", createdAt: now } });
      return a;
    },
    { maxWait: 20_000, timeout: 20_000 },
  );
  if (answer !== "ok") console.log(`[pool] offer ${offerId}: digits ${answer}`);
  return answer;
}

export async function loadOfferPage(offerId: string, opts: { verified: boolean; now?: Date; env?: Env }): Promise<OfferPage | null> {
  const now = opts.now ?? new Date();
  if (opts.verified) await stampIfOnItsWay(offerId, now);
  const o = await loadOffer(offerId);
  if (!o) return null;
  const profile = await profileOf(o.userId);
  const lang = normaliseLang(profile?.language);
  const facts = await loadMatchOfferFacts(o.matchId, now);
  return {
    lang,
    state: await stateOf(o, profile?.status === "active", now, opts.env),
    // Unproved (a forwarded link), the game's facts only: his distance says
    // where he lives.
    facts: facts ? { ...facts, places: o.ask.places, distanceMiles: opts.verified ? o.distanceMiles : null } : null,
    verified: opts.verified,
  };
}

/** Who an offer is between (slice L7: the offer page's block and report). */
export async function offerParties(offerId: string): Promise<{ userId: string; orgId: string; matchId: string; club: string; blocked: boolean } | null> {
  const o = await db.poolOffer.findUnique({ where: { id: offerId }, select: { userId: true, orgId: true, matchId: true, ask: { select: { org: { select: { name: true } } } } } });
  if (!o) return null;
  const block = await db.poolBlock.findFirst({ where: { orgId: o.orgId, userId: o.userId, by: "player" }, select: { id: true } });
  return { userId: o.userId, orgId: o.orgId, matchId: o.matchId, club: o.ask.org.name, blocked: !!block };
}

/** The organisers' record line for him: counts only. */
async function recordOf(userId: string) {
  const [confirmedCompleted, noShows, lateCancels] = await Promise.all([
    db.attendance.count({ where: { userId, status: "CONFIRMED", match: { status: "COMPLETED" } } }),
    db.guestPlace.count({ where: { userId, result: "no-show" } }),
    db.guestPlace.count({ where: { userId, result: "late-cancel" } }),
  ]);
  return organiserRecordOf({ confirmedCompleted, noShows, lateCancels });
}

async function tellOrganisersOnce(o: LoadedOffer, key: string, text: string, now: Date): Promise<void> {
  try {
    await db.sentNotification.create({ data: { key, kind: "pool-guest", matchId: o.matchId } });
  } catch {
    return; // told already
  }
  await sendAdminNotice({ orgId: o.orgId, now, holdOvernight: false, text });
}

/** How he answered: the tap link's page, or his own words by DM (L6). */
export type OfferAnswerVia = "link" | "words";

export async function acceptOffer(offerId: string, now: Date = new Date(), env?: Env, via: OfferAnswerVia = "link"): Promise<OfferPageState> {
  // He holds the link, so the DM reached him even if its report was lost.
  await stampIfOnItsWay(offerId, now);
  const o = await loadOffer(offerId);
  if (!o) return "invalid";
  const profile = await profileOf(o.userId);
  const refusal = refusalOf(o, profile?.status === "active", now, env);
  if (refusal || o.outcome) return stateOf(o, profile?.status === "active", now, env);

  const claimed = await db.poolOffer.updateMany({ where: { id: o.id, outcome: null }, data: { outcome: "accepted", resolvedAt: now, repliedVia: via } });
  if (claimed.count === 0) return stateOf((await loadOffer(offerId))!, true, now);

  const placed = await placePoolGuest({
    offerId: o.id,
    userId: o.userId,
    orgId: o.orgId,
    matchId: o.matchId,
    benchPickMode: o.ask.org.benchPickMode,
    fill: () => poolAskFill({ id: o.ask.id, roundId: o.ask.roundId, matchId: o.matchId, places: o.ask.places }),
    now,
  });
  if (placed.kind === "gone") {
    await db.poolOffer.updateMany({ where: { id: o.id, outcome: "accepted" }, data: { outcome: "filled", resolvedAt: now } });
    return "gone";
  }
  if (placed.kind === "failed" || placed.kind === "elsewhere") {
    // Nothing was written: the offer is his to answer again (minor 6: he
    // is this club's guest for another game already, so not now).
    await db.poolOffer.updateMany({ where: { id: o.id, outcome: "accepted" }, data: { outcome: null, resolvedAt: null, repliedVia: null } });
    return placed.kind === "elsewhere" ? "busy" : "open";
  }
  const bench = placed.kind === "bench";
  await db.poolProfile.updateMany({ where: { userId: o.userId }, data: { lastActiveAt: now } });

  const clubLang = o.ask.org.language;
  // Slice G4: "Brought by Ali K." on his FIRST game, when the friend who
  // brought him lets himself be named.
  const broughtBy = await broughtByForFirstGame(o.userId);
  const notice = poolOrganiserNotice(normaliseLang(clubLang), {
    name: shortDisplayName(profile?.displayName ?? ""),
    day: dayCommaTimeLabel(clubLang, o.ask.match.date),
    bench,
    record: await recordOf(o.userId),
  });
  await tellOrganisersOnce(o, `pool-offer:${o.id}:placed`, broughtBy ? `${notice} ${poolReferralCopy(clubLang).broughtBy(broughtBy)}` : notice, now);

  const phone = profile?.user?.phoneNumber;
  const facts = await loadMatchOfferFacts(o.matchId, now);
  if (phone && facts) {
    try {
      await queuePlatformDm({
        phone,
        purpose: "pool-placed",
        refId: o.id,
        text: poolPlacedText(normaliseLang(profile?.language), {
          club: facts.club,
          kickoff: facts.kickoff,
          venueName: facts.venueName,
          bench,
          fee: facts.fee,
          offerLink: appUrl(poolOfferPath(o.id)),
          manageLink: await buildPoolManageLink(o.userId),
        }),
      });
    } catch (err) {
      console.error(`[pool] offer ${o.id}: the match details DM was not queued:`, err instanceof Error ? err.message : "failed");
    }
  }

  if (placed.roundNowFull) await closeFilledRound(o, now);
  return bench ? "bench" : "in";
}

/** His place filled the round: the pool ask and every partner ask of the
 *  round close now (each partner group hears its one "filled" line). */
async function closeFilledRound(o: LoadedOffer, now: Date): Promise<void> {
  await closePoolAsk(o.ask.id, "filled", now);
  if (!o.ask.roundId) return;
  const partner = await db.partnerAsk.findFirst({ where: { roundId: o.ask.roundId, status: { in: ["awaiting-approval", "posted"] } }, select: { id: true } });
  if (partner) {
    const { closeRoundIfDue } = await import("../partner-ask");
    await closeRoundIfDue(partner.id, now);
  }
}

export async function declineOffer(offerId: string, now: Date = new Date(), via: OfferAnswerVia = "link"): Promise<OfferPageState> {
  // He holds the link, so the DM reached him even if its report was lost.
  await stampIfOnItsWay(offerId, now);
  const o = await loadOffer(offerId);
  if (!o) return "invalid";
  if (!o.outcome && o.sentAt) {
    const done = await db.poolOffer.updateMany({ where: { id: o.id, outcome: null }, data: { outcome: "declined", resolvedAt: now, repliedVia: via } });
    if (done.count > 0) {
      await db.poolProfile.updateMany({ where: { userId: o.userId }, data: { lastActiveAt: now } });
      console.log(`[pool] offer ${o.id}: declined`);
      return "declined";
    }
  }
  const profile = await profileOf(o.userId);
  return stateOf((await loadOffer(offerId))!, profile?.status === "active", now);
}

export async function pullOutOfOffer(offerId: string, now: Date = new Date()): Promise<OfferPageState> {
  // He holds the link, so the DM reached him even if its report was lost.
  await stampIfOnItsWay(offerId, now);
  const o = await loadOffer(offerId);
  if (!o) return "invalid";
  const profile = await profileOf(o.userId);
  if (o.outcome !== "accepted" || !matchLiveOf(o.ask.match) || now.getTime() >= o.ask.match.date.getTime()) {
    return stateOf(o, profile?.status === "active", now);
  }
  const cutoff = askWindows(o.ask.match.date, (await loadPartnerAskSettings(o.orgId))?.cutoffHours ?? 4).postBy;
  const done = await withdrawPoolGuest({ userId: o.userId, matchId: o.matchId, orgId: o.orgId, offerId: o.id, result: pullOutResult({ now, cutoff }), now });
  if (done) {
    await db.poolProfile.updateMany({ where: { userId: o.userId }, data: { lastActiveAt: now } });
    const clubLang = o.ask.org.language;
    await tellOrganisersOnce(
      o,
      `pool-offer:${o.id}:out`,
      poolCopy(clubLang).notice_out({ name: shortDisplayName(profile?.displayName ?? ""), day: dayCommaTimeLabel(clubLang, o.ask.match.date) }),
      now,
    );
  }
  return stateOf((await loadOffer(offerId))!, profile?.status === "active", now);
}
