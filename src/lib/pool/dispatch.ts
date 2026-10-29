/**
 * POOL OFFERS AT DISPATCH, THE I/O HALF (slice L5a, 2026-10-24; revised by
 * the review of #400, M3). The rules are `dispatch-rules.ts`; the design is
 * L4's `caps.ts` header.
 *
 * `claimDuePlatformJobs` (platform-jobs.ts) hands the due `pool-offer`
 * jobs here BEFORE it claims anything else. In ONE transaction holding
 * `pg_advisory_xact_lock(hashtext('pool-platform-cap'))`: the offers are
 * read fresh, the platform count is taken (pool jobs CLAIMED and not
 * released, or SENT, by their claim or send time), the plan is made and
 * applied. Admitted jobs are CLAIMED here (queued -> claimed, the same
 * compare-and-set as every claim), so the count and the claim are one
 * step under the lock and no two claimers can spend the same room.
 * Cancelled ones end `cancelled` and their job is failed ("cancelled:
 * ..."). No night hold (2026-10-29): nothing is deferred here.
 *
 * DELIVERED IS THE PI'S WORD (M3). Nothing here says the offer reached
 * him. `onPoolOfferJobSent` (the Pi's "sent") stamps `PoolOffer.sentAt` and
 * starts its six hours; a release puts the job back in the queue, where it
 * counts for nothing; `onPoolOfferJobFailed` ends the offer `cancelled`.
 */
import { db } from "../db";
import { askWindows } from "../partner-ask-rules";
import { loadPartnerAskSettings } from "../club-partnership";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "../club-partnership-rules";
import { ledgerEntryOf } from "./candidate-rows";
import { POOL_CAPS } from "./rules";
import { DM_SUB_FIELDS, type DmSubField } from "../dm-subscriptions";
import { optedOutOfDms, planPoolAdmission, poolOfferCancelFailReason, type PoolJobView } from "./dispatch-rules";
import { poolOffersOpenForClub, poolSwitchUnread } from "./flags";
import { OPEN_MATCH_STATUSES } from "./matching-rules";
import { offerExpiresAt } from "./waves";

type Env = Record<string, string | undefined>;

export const POOL_OFFER_PURPOSE = "pool-offer" as const;
export const POOL_PLATFORM_CAP_LOCK = "pool-platform-cap";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const LEDGER_LOOKBACK_MS = (POOL_CAPS.declineCooldownDays + 7) * DAY_MS;

async function cutoffFor(orgId: string, kickoff: Date): Promise<Date> {
  return askWindows(kickoff, (await loadPartnerAskSettings(orgId))?.cutoffHours ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS).postBy;
}

export interface PoolAdmissionResult {
  /** Pool jobs NOT to hand out on this poll. */
  skip: Set<string>;
  /** Pool jobs admitted AND claimed here: hand them out as they are. */
  claimed: Set<string>;
}

export async function admitPoolOfferJobs(jobIds: readonly string[], opts: { now: Date; limit: number; env?: Env }): Promise<PoolAdmissionResult> {
  const skip = new Set<string>();
  const claimed = new Set<string>();
  if (jobIds.length === 0) return { skip, claimed };
  const { now, limit, env } = opts;
  // The platform switch could not be read this poll: hold every offer
  // (left queued, sent nothing), never cancel it as if switched off.
  if (poolSwitchUnread(env)) {
    for (const id of jobIds) skip.add(id);
    return { skip, claimed };
  }
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${POOL_PLATFORM_CAP_LOCK}))`;
        const offers = await tx.poolOffer.findMany({
          where: { platformJobId: { in: [...jobIds] } },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            userId: true,
            orgId: true,
            outcome: true,
            expiresAt: true,
            platformJobId: true,
            ask: { select: { status: true, org: { select: { featurePlayerPool: true } }, match: { select: { date: true, status: true, isHistorical: true } } } },
          },
        });
        const userIds = [...new Set(offers.map((o) => o.userId))];
        const since = new Date(now.getTime() - 26 * HOUR_MS);
        const [profiles, memberships, ledgerRows, busyJobs] = await Promise.all([
          tx.poolProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true, status: true, consentAt: true } }),
          // His DM preferences (the general opt-out, decision L6.10).
          tx.membership.findMany({
            where: { userId: { in: userIds }, leftAt: null },
            select: { userId: true, subPrefsUpdatedAt: true, ...Object.fromEntries(DM_SUB_FIELDS.map((f) => [f, true])) } as { userId: true; subPrefsUpdatedAt: true } & Record<DmSubField, true>,
          }),
          tx.poolOffer.findMany({
            where: { userId: { in: userIds }, createdAt: { gte: new Date(now.getTime() - LEDGER_LOOKBACK_MS) } },
            select: { id: true, userId: true, matchId: true, orgId: true, sentAt: true, createdAt: true, outcome: true, resolvedAt: true, platformJobId: true },
          }),
          // In flight or delivered, by when (a London day is at most 25 h).
          tx.platformJob.findMany({
            where: {
              purpose: POOL_OFFER_PURPOSE,
              OR: [
                { status: "claimed", claimedAt: { gte: since } },
                { status: { in: ["sent", "unconfirmed"] }, sentAt: { gte: since } },
              ],
            },
            select: { id: true, status: true, claimedAt: true, sentAt: true },
          }),
        ]);
        const inFlightAt = new Map(busyJobs.filter((j) => j.status === "claimed" && j.claimedAt).map((j) => [j.id, j.claimedAt as Date]));
        const busy = busyJobs.map((j) => (j.status === "claimed" ? j.claimedAt : j.sentAt)).filter((d): d is Date => !!d && d.getTime() <= now.getTime());
        const active = new Set(profiles.filter((p) => p.status === "active").map((p) => p.userId as string));
        const consentAt = new Map(profiles.map((p) => [p.userId as string, p.consentAt]));
        const optedOut = new Set(
          userIds.filter((u) => optedOutOfDms({ memberships: memberships.filter((m) => m.userId === u), poolConsentAt: consentAt.get(u) ?? null })),
        );
        const cutoffs = new Map<string, Date>();
        for (const o of offers) if (!cutoffs.has(o.id)) cutoffs.set(o.id, await cutoffFor(o.orgId, o.ask.match.date));

        const views: PoolJobView[] = offers.map((o) => {
          const m = o.ask.match;
          const gameOpen =
            (OPEN_MATCH_STATUSES as readonly string[]).includes(m.status) &&
            !m.isHistorical &&
            now.getTime() < m.date.getTime() &&
            now.getTime() < (cutoffs.get(o.id) as Date).getTime() &&
            now.getTime() < o.expiresAt.getTime();
          return {
            jobId: o.platformJobId as string,
            offerId: o.id,
            userId: o.userId,
            orgId: o.orgId,
            clubOpen: poolOffersOpenForClub(o.ask.org, env),
            profileActive: active.has(o.userId),
            dmOptedOut: optedOut.has(o.userId),
            offerOpen: o.outcome === null,
            askOpen: o.ask.status === "open",
            gameOpen,
            // His other offers that reached him (sentAt, or an answer), or are
            // on their way (claimed): what his caps count. Never one that is
            // only queued, nor one cancelled.
            ledger: ledgerRows
              .filter((r) => r.userId === o.userId && r.id !== o.id)
              .map((r) => ({ r, at: r.sentAt ?? (r.platformJobId ? inFlightAt.get(r.platformJobId) : undefined) ?? null }))
              .filter(({ r, at }) => at !== null || (r.outcome !== null && r.outcome !== "cancelled"))
              .map(({ r, at }) => ledgerEntryOf({ ...r, sentAt: at, jobSendAfter: null })),
          };
        });
        // A job whose offer row is gone (its match deleted): never sent.
        const known = new Set(views.map((v) => v.jobId));
        for (const id of jobIds) if (!known.has(id)) skip.add(id);

        const plan = planPoolAdmission(views, busy, now, limit);
        for (const jobId of plan.admit) {
          const { count } = await tx.platformJob.updateMany({ where: { id: jobId, status: "queued" }, data: { status: "claimed", claimedAt: now } });
          if (count === 1) claimed.add(jobId);
          else skip.add(jobId);
        }
        for (const c of plan.cancel) {
          skip.add(c.jobId);
          await tx.poolOffer.updateMany({ where: { id: c.offerId, outcome: null }, data: { outcome: "cancelled", resolvedAt: now } });
          await tx.platformJob.updateMany({
            where: { id: c.jobId, status: "queued" },
            data: { status: "failed", failedAt: now, failReason: poolOfferCancelFailReason(c.reason) },
          });
        }
        for (const id of plan.hold) skip.add(id);
        if (plan.admit.length + plan.cancel.length > 0) {
          console.log(
            `[pool] dispatch: ${claimed.size} claimed, ${plan.hold.length} held, ${plan.cancel.length} cancelled (${plan.cancel.map((c) => c.reason).join(", ") || "none"})`,
          );
        }
      },
      { maxWait: 20_000, timeout: 30_000 },
    );
  } catch (err) {
    // Never hand out a pool offer that was not admitted.
    console.error("[pool] dispatch admission failed; pool offers wait for the next poll:", err instanceof Error ? err.message : "failed");
    for (const id of jobIds) skip.add(id);
    claimed.clear();
  }
  return { skip, claimed };
}

/**
 * The Pi reported the offer's DM SENT: now it reached him. `sentAt` is
 * stamped and its six hours start (`offerExpiresAt`). One cancelled while
 * it was already on its way (its round closed) did reach him after all:
 * it ends `expired` (the round closed first, decision #8), so his caps and
 * a later reply know he saw it. Never throws.
 */
export async function onPoolOfferJobSent(jobId: string, now: Date = new Date(), deliveredAt: Date = now): Promise<void> {
  try {
    const offer = await db.poolOffer.findFirst({
      where: { platformJobId: jobId, sentAt: null },
      select: { id: true, orgId: true, outcome: true, ask: { select: { match: { select: { date: true } } } } },
    });
    if (!offer) return;
    const cutoff = await cutoffFor(offer.orgId, offer.ask.match.date);
    await db.poolOffer.updateMany({ where: { id: offer.id, sentAt: null }, data: { sentAt: deliveredAt, expiresAt: offerExpiresAt(deliveredAt, cutoff) } });
    if (offer.outcome === "cancelled") {
      await db.poolOffer.updateMany({ where: { id: offer.id, outcome: "cancelled" }, data: { outcome: "expired" } });
    }
  } catch (err) {
    console.error(`[pool] job ${jobId}: marking its offer delivered failed:`, err instanceof Error ? err.message : "failed");
  }
}

/** A claimed pool job with no report this long is taken as delivered. */
export const UNREPORTED_AFTER_MS = 5 * 60_000;

/**
 * A "sent" that never arrived (second review of #400, item 2): the Pi
 * retries its report, but if every try is lost, or stamping it failed here,
 * the job stays claimed and the offer would never be "delivered": the page
 * would call his link invalid and the offer would never end. So a pool job
 * CLAIMED more than `UNREPORTED_AFTER_MS` ago, or reported sent/unconfirmed
 * with its offer still unstamped, is taken as delivered at its send (or
 * claim) time. The job itself is left alone: a late report still lands.
 * Every platform poll (`round.ts` `sweepPool`). Never throws.
 */
export async function stampUnreportedDeliveries(now: Date = new Date()): Promise<number> {
  try {
    const jobs = await db.platformJob.findMany({
      where: {
        purpose: POOL_OFFER_PURPOSE,
        createdAt: { gte: new Date(now.getTime() - 3 * DAY_MS) },
        OR: [{ status: "claimed", claimedAt: { lte: new Date(now.getTime() - UNREPORTED_AFTER_MS) } }, { status: { in: ["sent", "unconfirmed"] } }],
      },
      select: { id: true, claimedAt: true, sentAt: true },
    });
    if (jobs.length === 0) return 0;
    const unstamped = await db.poolOffer.findMany({ where: { platformJobId: { in: jobs.map((j) => j.id) }, sentAt: null }, select: { platformJobId: true } });
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const o of unstamped) {
      const j = byId.get(o.platformJobId as string)!;
      await onPoolOfferJobSent(j.id, now, j.sentAt ?? j.claimedAt ?? now);
    }
    if (unstamped.length > 0) console.log(`[pool] ${unstamped.length} offer(s) taken as delivered: no report from the Pi`);
    return unstamped.length;
  } catch (err) {
    console.error("[pool] stamping unreported deliveries failed:", err instanceof Error ? err.message : "failed");
    return 0;
  }
}

/** For the HOLDER's own tap: his offer's job is claimed or sent, so the DM
 *  is with him (he has the link) even if no report arrived yet. */
export async function stampIfOnItsWay(offerId: string, now: Date = new Date()): Promise<void> {
  const o = await db.poolOffer.findUnique({ where: { id: offerId }, select: { sentAt: true, platformJobId: true } });
  if (!o || o.sentAt || !o.platformJobId) return;
  const j = await db.platformJob.findUnique({ where: { id: o.platformJobId }, select: { status: true, claimedAt: true, sentAt: true } });
  if (!j || !["claimed", "sent", "unconfirmed"].includes(j.status)) return;
  await onPoolOfferJobSent(o.platformJobId, now, j.sentAt ?? j.claimedAt ?? now);
}

export async function onPoolOfferJobFailed(jobId: string, now: Date = new Date()): Promise<void> {
  try {
    const done = await db.poolOffer.updateMany({ where: { platformJobId: jobId, outcome: null, sentAt: null }, data: { outcome: "cancelled", resolvedAt: now } });
    if (done.count > 0) console.log(`[pool] offer of job ${jobId} cancelled: the send failed`);
  } catch (err) {
    console.error(`[pool] job ${jobId}: marking its offer failed did not work:`, err instanceof Error ? err.message : "failed");
  }
}
