/**
 * ASKING THE POOL: THE ROUND RUNNER (slice L5a, 2026-10-24). Thin I/O
 * around the pure rules (`round-rules.ts`, L4's `matching-rules.ts`,
 * `caps.ts`, `waves.ts`) and the composer (`offer-copy.ts`).
 *
 * The pool is one more source in the partner-ask ROUND (plan 4.1, 7): a
 * `PoolAsk` carries the round's `roundId` (or none, for a pool-only round,
 * whose key is then its own id), and the round's fill counts partner and
 * pool guests together (`partner-ask-round.ts`).
 *
 *   requestPoolAsk  an organiser's one-tap approval (the match page; L9
 *                   adds the automatic ask, L10 asking in words and a YES
 *                   in HQ, `pool-ask-words.ts`). Checks
 *                   every rule, writes the ask, and sends wave 1 at once
 *                   when no partner ask of the round is open.
 *   sweepPool       every platform-jobs poll (the Pi polls it whatever the
 *                   clubs' switches say): offers whose own time ran out
 *                   become "ignored" (3 in a row pause him, one DM says
 *                   so); asks close when they should (the switch, the game,
 *                   the round filled, the cut-off); wave 1 an hour after
 *                   the partners, wave 2 thirty minutes after wave 1.
 *   cancelPoolAsk   the organiser cancels the round (with its partner asks).
 *
 * THE MESSAGES (decision L5a.6, the minimal set): one offer DM per person;
 * nothing when a round closes (no "thanks, filled" to everyone asked:
 * every extra DM costs pacing and ban risk); a tap after it closed shows
 * "this place has gone" on the page, and a reply in words gets one line
 * (`reply.ts`). One DM when he is paused for ignoring offers.
 *
 * OFFERS GO AS PLATFORM DMs (`queuePlatformDm`, purpose "pool-offer"),
 * only to an ACTIVE profile with consent on record (L4's filters: such a
 * profile exists only after his own WhatsApp message confirmed it, so
 * MatchTime never writes first). Quiet hours defer the job (`sendAfter`);
 * the platform cap, his caps and every switch are re-checked at dispatch
 * (`dispatch.ts`). Logs carry ids only.
 */
import { db } from "../db";
import { appUrl } from "../app-url";
import { loadPartnerAskSettings } from "../club-partnership";
import { askWindows } from "../partner-ask-rules";
import { loadRoundFill } from "../partner-ask-round";
import { queuePlatformDm } from "../platform-jobs";
import { pausesForIgnored } from "./caps";
import { ledgerEntryOf } from "./candidate-rows";
import { findPoolCandidates } from "./candidates";
import { POOL_OFFER_PURPOSE, stampUnreportedDeliveries } from "./dispatch";
import { isPoolOffersEnabled, poolOffersOpenForClub, poolSwitchUnread } from "./flags";
import { buildPoolManageLink } from "./links";
import { OPEN_MATCH_STATUSES } from "./matching-rules";
import { loadMatchOfferFacts } from "./offer-facts";
import { poolOfferText, poolPausedText } from "./offer-copy";
import { poolOfferPath } from "./offer-token";
import {
  askStatusFor,
  offerOutcomeOnClose,
  ownTimeRanOut,
  poolAskCloseReason,
  poolAskRefusal,
  wave1DueAt,
  type PoolAskCloseReason,
  type PoolAskRefusal,
} from "./round-rules";
import { POOL_CAPS, POOL_ROUND } from "./rules";
import { eachUnderSavepoint } from "./savepoint";
import { firstWaveSize, offerExpiresAt, poolSendAt, secondWave } from "./waves";
import { normaliseLang } from "../i18n/lang";
import type { PoolAskVia } from "./vocab";

type Env = Record<string, string | undefined>;
const DAY_MS = 24 * 3600_000;

/** The club's cut-off for this match: nothing is asked or open past it. */
async function cutoffOf(orgId: string, kickoff: Date): Promise<Date> {
  const settings = await loadPartnerAskSettings(orgId);
  return askWindows(kickoff, settings?.cutoffHours ?? 4).postBy;
}

/** The match's places not yet taken (CONFIRMED against its size). */
export async function placesOpenOf(matchId: string): Promise<number> {
  const m = await db.match.findUnique({ where: { id: matchId }, select: { maxPlayers: true } });
  if (!m) return 0;
  const confirmed = await db.attendance.count({ where: { matchId, status: "CONFIRMED" } });
  return Math.max(0, m.maxPlayers - confirmed);
}

async function isOrganiser(userId: string | null, orgId: string): Promise<boolean> {
  if (!userId) return false;
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true, leftAt: true, guestMatchId: true } });
  return !!m && !m.leftAt && !m.guestMatchId && (m.role === "OWNER" || m.role === "ADMIN");
}

export type PoolAskResult = { ok: true; askId: string; waveSent: boolean } | { ok: false; refusal: PoolAskRefusal | "not-found" };

export async function requestPoolAsk(args: {
  orgId: string;
  matchId: string;
  places: number;
  /** The round's id when partner clubs were asked in the same press. */
  roundId: string | null;
  approvedByUserId: string | null;
  via: PoolAskVia;
  now?: Date;
  env?: Env;
}): Promise<PoolAskResult> {
  const now = args.now ?? new Date();
  const match = await db.match.findUnique({ where: { id: args.matchId }, select: { date: true, activity: { select: { orgId: true, org: { select: { featurePlayerPool: true } } } } } });
  if (!match || match.activity.orgId !== args.orgId) return { ok: false, refusal: "not-found" };
  const [found, organiser, cutoff, placesOpen, clubAsks] = await Promise.all([
    findPoolCandidates(args.matchId, { now, env: args.env }),
    args.via === "auto" ? Promise.resolve(true) : isOrganiser(args.approvedByUserId, args.orgId),
    cutoffOf(args.orgId, match.date),
    placesOpenOf(args.matchId),
    db.poolAsk.findMany({ where: { orgId: args.orgId, OR: [{ status: "open" }, { createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } }] }, select: { matchId: true, status: true, createdAt: true } }),
  ]);
  const refusal = poolAskRefusal({
    poolOpen: poolOffersOpenForClub(match.activity.org, args.env),
    organiser,
    gate: found.selection.gate,
    now,
    cutoff,
    placesOpen,
    places: args.places,
    clubAsks,
    matchId: args.matchId,
    eligible: found.selection.eligible.length,
  });
  if (refusal) {
    console.log(`[pool] ask for match ${args.matchId} by ${args.orgId} refused: ${refusal}`);
    return { ok: false, refusal };
  }
  let askId: string;
  try {
    const ask = await db.poolAsk.create({
      // `createdAt` is the moment the rules judged (the partners-first hour
      // and the club's weekly count run from it), not the database's clock.
      data: { matchId: args.matchId, orgId: args.orgId, roundId: args.roundId, places: args.places, via: args.via, approvedByUserId: args.approvedByUserId, createdAt: now },
      select: { id: true },
    });
    askId = ask.id;
  } catch (err) {
    // The partial unique index: one open ask per match and club.
    if ((err as { code?: string })?.code === "P2002") return { ok: false, refusal: "round-open" };
    throw err;
  }
  console.log(`[pool] ask ${askId}: ${args.orgId} asks the pool for ${args.places} on match ${args.matchId} (${args.via}${args.roundId ? `, round ${args.roundId}` : ""})`);
  const partnersOpen = args.roundId ? await db.partnerAsk.count({ where: { roundId: args.roundId, status: { in: ["awaiting-approval", "posted"] } } }) : 0;
  const due = wave1DueAt({ createdAt: now, partnerAsksOpen: partnersOpen });
  const waveSent = due.getTime() <= now.getTime() ? (await sendWave(askId, 1, now, args.env)) > 0 : false;
  return { ok: true, askId, waveSent };
}

/**
 * Queue one wave's offers. Returns how many were queued.
 *
 * ONE WAVE AT A TIME PER ASK (review of #400, minor 4): two sweeps at once
 * must never both send a wave or take a round past `POOL_ROUND.maxOffers`.
 * The writes run in one transaction holding `pg_advisory_xact_lock` on the
 * ask, which re-reads under it what the ask already sent.
 *
 * SMALL AND SAFE (second review, item 3): who to ask, the facts and each
 * person's manage link are worked out BEFORE the transaction (they read
 * and write elsewhere); inside it each person is one savepoint step
 * (`savepoint.ts`), so one failure skips only that person.
 */
async function sendWave(askId: string, wave: 1 | 2, now: Date, env: Env | undefined, size?: number): Promise<number> {
  try {
    const ask = await db.poolAsk.findUnique({ where: { id: askId }, select: { id: true, matchId: true, orgId: true, places: true, status: true } });
    if (!ask || ask.status !== "open") return 0;
    const found = await findPoolCandidates(ask.matchId, { now, env });
    if (found.selection.gate || !found.ctx) return 0;
    const facts = await loadMatchOfferFacts(ask.matchId, now);
    if (!facts) return 0;
    const cutoff = await cutoffOf(ask.orgId, found.ctx.kickoff);
    const want = Math.min(POOL_ROUND.maxOffers, size ?? firstWaveSize(found.selection.eligible.length, ask.places));
    const shortlist = found.selection.eligible.slice(0, want);
    if (shortlist.length === 0) return 0;
    const profiles = await db.poolProfile.findMany({
      where: { userId: { in: shortlist.map((p) => p.userId) } },
      select: { userId: true, language: true, user: { select: { phoneNumber: true } } },
    });
    const byUser = new Map(profiles.map((p) => [p.userId as string, p]));
    const prepared: Array<{ userId: string; distanceMiles: number; phone: string; lang: ReturnType<typeof normaliseLang>; manageLink: string }> = [];
    for (const c of shortlist) {
      const profile = byUser.get(c.userId);
      const phone = profile?.user?.phoneNumber;
      if (!profile || !phone) continue;
      prepared.push({ userId: c.userId, distanceMiles: c.distanceMiles, phone, lang: normaliseLang(profile.language), manageLink: await buildPoolManageLink(c.userId) });
    }
    const sendAfter = found.sendAt.getTime() > now.getTime() ? found.sendAt : null;

    const queued = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pool-ask:${askId}`}))`;
        const fresh = await tx.poolAsk.findUnique({ where: { id: askId }, select: { status: true } });
        if (fresh?.status !== "open") return 0;
        const already = await tx.poolOffer.findMany({ where: { poolAskId: askId }, select: { wave: true } });
        if (already.some((o) => o.wave === wave)) return 0;
        const room = POOL_ROUND.maxOffers - already.length;
        if (room <= 0) return 0;
        const offeredHere = new Set(
          (await tx.poolOffer.findMany({ where: { matchId: ask.matchId, userId: { in: prepared.map((p) => p.userId) } }, select: { userId: true } })).map((o) => o.userId),
        );
        const go = prepared.filter((p) => !offeredHere.has(p.userId)).slice(0, room);
        const done = await eachUnderSavepoint(
          tx,
          go,
          async (p) => {
            const offer = await tx.poolOffer.create({
              data: {
                poolAskId: ask.id,
                matchId: ask.matchId,
                orgId: ask.orgId,
                userId: p.userId,
                distanceMiles: p.distanceMiles,
                wave,
                // The planned window; the real six hours start when the Pi
                // reports the DM sent (`dispatch.ts` `onPoolOfferJobSent`).
                expiresAt: offerExpiresAt(found.sendAt, cutoff),
                // The caps count a queued offer at its creation (L4.3).
                createdAt: now,
              },
              select: { id: true },
            });
            const text = poolOfferText(p.lang, { ...facts, places: ask.places, distanceMiles: p.distanceMiles }, {
              tapLink: appUrl(poolOfferPath(offer.id)),
              manageLink: p.manageLink,
            });
            const job = await queuePlatformDm({
              phone: p.phone,
              text,
              purpose: POOL_OFFER_PURPOSE,
              refId: offer.id,
              sendAfter,
              client: tx as unknown as Parameters<typeof queuePlatformDm>[0]["client"],
            });
            await tx.poolOffer.update({ where: { id: offer.id }, data: { platformJobId: job.id } });
            return offer.id;
          },
          (p, err) => console.error(`[pool] ask ${askId}: offer to ${p.userId} skipped:`, err instanceof Error ? err.message : "failed"),
        );
        return done.length;
      },
      { maxWait: 20_000, timeout: 30_000 },
    );
    console.log(`[pool] ask ${askId}: wave ${wave}, ${queued} offer(s) queued${sendAfter ? ` for ${sendAfter.toISOString()}` : ""}`);
    return queued;
  } catch (err) {
    console.error(`[pool] ask ${askId}: wave ${wave} not queued:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}

/** Close one open ask for `reason`: compare-and-set, then its offers. */
export async function closePoolAsk(askId: string, reason: PoolAskCloseReason, now: Date = new Date()): Promise<boolean> {
  const done = await db.poolAsk.updateMany({ where: { id: askId, status: "open" }, data: { status: askStatusFor(reason), closeReason: reason, closedAt: now } });
  if (done.count === 0) return false;
  const open = await db.poolOffer.findMany({ where: { poolAskId: askId, outcome: null }, select: { id: true, sentAt: true } });
  for (const o of open) {
    await db.poolOffer.updateMany({ where: { id: o.id, outcome: null }, data: { outcome: offerOutcomeOnClose(o), resolvedAt: now } });
  }
  const unsent = open.filter((o) => !o.sentAt).map((o) => o.id);
  if (unsent.length > 0) {
    const { cancelQueuedPlatformDms } = await import("../platform-jobs");
    await cancelQueuedPlatformDms({ purposes: ["pool-offer"], refIds: unsent, reason: `pool ask ${reason}`, now });
  }
  console.log(`[pool] ask ${askId}: closed (${reason}), ${open.length} open offer(s) ended`);
  return true;
}

/** The organiser cancels the round: the pool ask of this round key. */
export async function cancelPoolAsk(args: { orgId: string; matchId: string; roundKey: string; now?: Date }): Promise<number> {
  const asks = await db.poolAsk.findMany({
    where: { orgId: args.orgId, matchId: args.matchId, status: "open", OR: [{ roundId: args.roundKey }, { id: args.roundKey }] },
    select: { id: true },
  });
  let n = 0;
  for (const a of asks) if (await closePoolAsk(a.id, "organiser-cancelled", args.now)) n++;
  return n;
}

/** The round's fill for a pool ask (one definition: partner-ask-round.ts). */
export function poolAskFill(ask: { id: string; roundId: string | null; matchId: string; places: number }) {
  return loadRoundFill({ id: ask.id, roundId: ask.roundId, matchId: ask.matchId, places: ask.places, volunteerUserIds: [], pickedUserIds: [] });
}

/** Offers whose own time ran out: "ignored", and the pause rule. */
async function expireOwnTime(ask: { id: string; cutoff: Date }, now: Date, env?: Env): Promise<void> {
  const open = await db.poolOffer.findMany({
    where: { poolAskId: ask.id, outcome: null, sentAt: { not: null }, expiresAt: { lte: now } },
    select: { id: true, userId: true, sentAt: true, expiresAt: true },
  });
  for (const o of open) {
    if (!ownTimeRanOut({ sentAt: o.sentAt, expiresAt: o.expiresAt, cutoff: ask.cutoff, now })) continue;
    const done = await db.poolOffer.updateMany({ where: { id: o.id, outcome: null }, data: { outcome: "ignored", resolvedAt: now } });
    if (done.count > 0) await pauseIfIgnoring(o.userId, now, env);
  }
}

/**
 * Three ignored in a row pause him ("until they say they want more"): only
 * offers since his last activity count (`lastActiveAt`: a reply, a game,
 * the manage page; decision L5a.7), so resuming starts the count again.
 * One DM with the manage link, once (the status compare-and-set).
 */
async function pauseIfIgnoring(userId: string, now: Date, env?: Env): Promise<void> {
  // No pool message of any kind while the master switch is off (minor 5).
  if (!isPoolOffersEnabled(env)) return;
  const profile = await db.poolProfile.findUnique({ where: { userId }, select: { status: true, language: true, lastActiveAt: true, user: { select: { phoneNumber: true } } } });
  if (!profile || profile.status !== "active") return;
  const rows = await db.poolOffer.findMany({
    where: { userId, createdAt: { gte: new Date(now.getTime() - 60 * DAY_MS) } },
    select: { userId: true, matchId: true, orgId: true, sentAt: true, createdAt: true, outcome: true, resolvedAt: true },
  });
  if (!pausesForIgnored(rows.map((r) => ledgerEntryOf({ ...r, jobSendAfter: null })), profile.lastActiveAt)) return;
  const done = await db.poolProfile.updateMany({ where: { userId, status: "active" }, data: { status: "paused", pausedReason: "ignored", pausedAt: now } });
  if (done.count === 0 || !profile.user?.phoneNumber) return;
  console.log(`[pool] ${userId}: paused after ${POOL_CAPS.ignoredInARowPause} ignored offers`);
  await queuePlatformDm({
    phone: profile.user.phoneNumber,
    text: poolPausedText(normaliseLang(profile.language), { n: POOL_CAPS.ignoredInARowPause, manageLink: await buildPoolManageLink(userId) }),
    purpose: "pool-paused",
    refId: userId,
    // Not a reply to anything he sent: the pool's quiet hours hold it.
    sendAfter: poolSendAt(now).getTime() > now.getTime() ? poolSendAt(now) : null,
  });
}

/** Every platform-jobs poll. Never throws. */
export async function sweepPool(now: Date = new Date(), env?: Env): Promise<{ closed: number; queued: number }> {
  let closed = 0;
  let queued = 0;
  // Offers whose "sent" report never arrived are delivered all the same.
  await stampUnreportedDeliveries(now);
  try {
    const asks = await db.poolAsk.findMany({
      where: { status: "open" },
      select: {
        id: true,
        matchId: true,
        orgId: true,
        roundId: true,
        places: true,
        createdAt: true,
        org: { select: { featurePlayerPool: true } },
        match: { select: { date: true, status: true, isHistorical: true } },
      },
    });
    for (const ask of asks) {
      try {
        // The switches FIRST (review of #400, minor 5): with the pool off
        // nothing more happens for this ask, not even a pause message.
        if (!poolOffersOpenForClub(ask.org, env)) {
          // A switch that could not be read this poll is not the owner
          // switching it off: nothing is sent, nothing is closed.
          if (!poolSwitchUnread(env) && (await closePoolAsk(ask.id, "switched-off", now))) closed++;
          continue;
        }
        const cutoff = await cutoffOf(ask.orgId, ask.match.date);
        await expireOwnTime({ id: ask.id, cutoff }, now, env);
        const [fill, placesOpen] = await Promise.all([poolAskFill(ask), placesOpenOf(ask.matchId)]);
        const reason = poolAskCloseReason({
          now,
          cutoff,
          matchLive: (OPEN_MATCH_STATUSES as readonly string[]).includes(ask.match.status) && !ask.match.isHistorical && ask.match.date.getTime() > now.getTime(),
          poolOpen: poolOffersOpenForClub(ask.org, env),
          roundPlaced: fill.placed,
          roundWanted: fill.wanted,
          placesOpen,
        });
        if (reason) {
          if (await closePoolAsk(ask.id, reason, now)) closed++;
          continue;
        }
        const offers = await db.poolOffer.findMany({ where: { poolAskId: ask.id }, select: { wave: true, sentAt: true } });
        const wave1 = offers.filter((o) => o.wave === 1);
        if (wave1.length === 0) {
          const partnersOpen = ask.roundId ? await db.partnerAsk.count({ where: { roundId: ask.roundId, status: { in: ["awaiting-approval", "posted"] } } }) : 0;
          if (wave1DueAt({ createdAt: ask.createdAt, partnerAsksOpen: partnersOpen }).getTime() <= now.getTime()) queued += await sendWave(ask.id, 1, now, env);
          continue;
        }
        if (offers.some((o) => o.wave === 2)) continue;
        const sentTimes = wave1.map((o) => o.sentAt).filter((d): d is Date => !!d);
        if (sentTimes.length === 0) continue;
        const next = secondWave({
          wave1SentAt: new Date(Math.min(...sentTimes.map((d) => d.getTime()))),
          wave1Count: wave1.length,
          placesOpen: Math.min(placesOpen, fill.wanted - fill.placed),
          cutoff,
          now,
        });
        if (next.kind === "send") queued += await sendWave(ask.id, 2, now, env, next.size);
      } catch (err) {
        console.error(`[pool] ask ${ask.id}: sweep step failed:`, err instanceof Error ? err.message : "failed");
      }
    }
  } catch (err) {
    console.error("[pool] sweep failed:", err instanceof Error ? err.message : "failed");
  }
  return { closed, queued };
}
