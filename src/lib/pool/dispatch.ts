/**
 * POOL OFFERS AT DISPATCH, THE I/O HALF (slice L5a, 2026-10-24). The rules
 * are `dispatch-rules.ts`; the design is L4's `caps.ts` header.
 *
 * `claimDuePlatformJobs` (platform-jobs.ts) calls `admitPoolOfferJobs`
 * with the due `pool-offer` jobs it read, BEFORE it claims anything. Here,
 * in ONE transaction holding `pg_advisory_xact_lock(hashtext(
 * 'pool-platform-cap'))`, the offers are read fresh, the platform count is
 * taken, the plan is made and applied: admitted offers get `sentAt` now
 * and their expiry (`waves.ts` `offerExpiresAt`); cancelled ones end
 * `cancelled` and their job is failed ("cancelled: ..."); deferred ones
 * have their job held to the end of quiet hours. The lock serialises every
 * claimer (two Pi processes, two polls), and the count and the stamp are
 * in the same transaction, so no two can spend the same room.
 *
 * Returns the job ids NOT to hand out on this poll (held, deferred,
 * cancelled). An admitted job is then claimed by the ordinary
 * compare-and-set; if the Pi releases it (its DM pacing), it comes back
 * here admitted and passes again without using room.
 *
 * `onPoolOfferJobFailed`: the Pi reported the send failed, so the offer
 * never reached him: it ends `cancelled` (no cap counts it).
 */
import { db } from "../db";
import { askWindows } from "../partner-ask-rules";
import { loadPartnerAskSettings } from "../club-partnership";
import { ledgerEntryOf } from "./candidate-rows";
import { POOL_CAPS } from "./rules";
import { planPoolAdmission, type PoolJobView } from "./dispatch-rules";
import { poolOffersOpenForClub } from "./flags";
import { offerExpiresAt } from "./waves";

type Env = Record<string, string | undefined>;

export const POOL_OFFER_PURPOSE = "pool-offer" as const;
export const POOL_PLATFORM_CAP_LOCK = "pool-platform-cap";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const LEDGER_LOOKBACK_MS = (POOL_CAPS.declineCooldownDays + 7) * DAY_MS;
const CANCEL_PREFIX = "cancelled: ";

export async function admitPoolOfferJobs(
  jobIds: readonly string[],
  opts: { now: Date; limit: number; env?: Env },
): Promise<Set<string>> {
  const skip = new Set<string>();
  if (jobIds.length === 0) return skip;
  const { now, limit, env } = opts;
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
            matchId: true,
            sentAt: true,
            outcome: true,
            platformJobId: true,
            ask: { select: { status: true, org: { select: { featurePlayerPool: true } }, match: { select: { date: true } } } },
          },
        });
        const userIds = [...new Set(offers.map((o) => o.userId))];
        const [profiles, ledgerRows, sent] = await Promise.all([
          tx.poolProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true, status: true } }),
          tx.poolOffer.findMany({
            where: { userId: { in: userIds }, createdAt: { gte: new Date(now.getTime() - LEDGER_LOOKBACK_MS) } },
            select: { id: true, userId: true, matchId: true, orgId: true, sentAt: true, createdAt: true, outcome: true, resolvedAt: true },
          }),
          // A London day is at most 25 hours: 26 covers it and the last hour.
          tx.poolOffer.findMany({ where: { sentAt: { not: null, gte: new Date(now.getTime() - 26 * HOUR_MS), lte: now } }, select: { sentAt: true } }),
        ]);
        const active = new Set(profiles.filter((p) => p.status === "active").map((p) => p.userId as string));
        const views: PoolJobView[] = offers.map((o) => ({
          jobId: o.platformJobId as string,
          offerId: o.id,
          userId: o.userId,
          orgId: o.orgId,
          admitted: o.sentAt !== null,
          clubOpen: poolOffersOpenForClub(o.ask.org, env),
          profileActive: active.has(o.userId),
          offerOpen: o.outcome === null,
          askOpen: o.ask.status === "open",
          ledger: ledgerRows
            .filter((r) => r.userId === o.userId && r.id !== o.id && (r.sentAt !== null || r.outcome !== null))
            .map((r) => ledgerEntryOf({ ...r, jobSendAfter: null })),
        }));
        // A job whose offer row is gone (its match deleted): never sent.
        const known = new Set(views.map((v) => v.jobId));
        for (const id of jobIds) if (!known.has(id)) skip.add(id);

        const plan = planPoolAdmission(views, sent.map((s) => s.sentAt as Date), now, limit);
        const byJob = new Map(offers.map((o) => [o.platformJobId as string, o]));

        for (const jobId of plan.admit) {
          const o = byJob.get(jobId)!;
          if (o.sentAt) continue;
          const settings = await loadPartnerAskSettings(o.orgId);
          const cutoff = askWindows(o.ask.match.date, settings?.cutoffHours ?? 4).postBy;
          await tx.poolOffer.updateMany({ where: { id: o.id, sentAt: null }, data: { sentAt: now, expiresAt: offerExpiresAt(now, cutoff) } });
        }
        for (const c of plan.cancel) {
          skip.add(c.jobId);
          await tx.poolOffer.updateMany({ where: { id: c.offerId, outcome: null }, data: { outcome: "cancelled", resolvedAt: now } });
          await tx.platformJob.updateMany({
            where: { id: c.jobId, status: "queued" },
            data: { status: "failed", failedAt: now, failReason: `${CANCEL_PREFIX}pool offer ${c.reason}` },
          });
        }
        for (const d of plan.defer) {
          skip.add(d.jobId);
          await tx.platformJob.updateMany({ where: { id: d.jobId, status: "queued" }, data: { sendAfter: d.until } });
          if (d.unadmit) await tx.poolOffer.updateMany({ where: { id: d.offerId }, data: { sentAt: null } });
        }
        for (const id of plan.hold) skip.add(id);
        if (plan.admit.length + plan.cancel.length + plan.defer.length > 0) {
          console.log(
            `[pool] dispatch: ${plan.admit.length} admitted, ${plan.hold.length} held, ${plan.defer.length} deferred, ${plan.cancel.length} cancelled (${plan.cancel.map((c) => c.reason).join(", ") || "none"})`,
          );
        }
      },
      { maxWait: 20_000, timeout: 30_000 },
    );
  } catch (err) {
    // Never hand out a pool offer that was not admitted.
    console.error("[pool] dispatch admission failed; pool offers wait for the next poll:", err instanceof Error ? err.message : "failed");
    for (const id of jobIds) skip.add(id);
  }
  return skip;
}

export async function onPoolOfferJobFailed(jobId: string, now: Date = new Date()): Promise<void> {
  try {
    const done = await db.poolOffer.updateMany({ where: { platformJobId: jobId, outcome: null }, data: { outcome: "cancelled", resolvedAt: now } });
    if (done.count > 0) console.log(`[pool] offer of job ${jobId} cancelled: the send failed`);
  } catch (err) {
    console.error(`[pool] job ${jobId}: marking its offer failed did not work:`, err instanceof Error ? err.message : "failed");
  }
}
