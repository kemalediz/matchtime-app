/**
 * CLUB FEE BILLING: the one writer of `Organisation.billingStatus`, slice B1.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2 and 4.4.
 *
 * ONE WRITER. Nothing outside this module may write `billingStatus`
 * (`__tests__/club-billing-source-guard.test.ts`). The transition table
 * lives in the pure `nextBillingState` (club-billing-rules.ts); this file
 * applies it inside one transaction holding a row lock on the club, so a
 * Stripe webhook and the billing cron arriving together are serialised and
 * the second always decides on fresh state.
 *
 * B1 ships the writer DARK: nothing calls `setBillingState` yet (B2 wires
 * approval and the platform owner's controls, B3 the webhook, B4 the
 * cron, B5 removal from the group). Every club is "exempt" by the column
 * default, and an exempt club only ever moves on an approval or "Start
 * free month" with BILLING_ENABLED on.
 *
 * NOTHING HERE MESSAGES ANYONE. The billing DMs are slice B4, through the
 * platform DM channel; `resumeClub` deliberately posts nothing in the
 * group (4.4 point 4).
 *
 * NOT the mute switch: `whatsappBotEnabled` is never written here, so a
 * resume can never unmute a club the platform owner muted by hand.
 */
import type { MatchStatus } from "@/generated/prisma/enums";
import { db } from "./db";
import {
  RESUME_QUIET_LOOKBACK_DAYS,
  isBillingEnabled,
  isBillingPaused,
  nextBillingState,
  trialWindow,
  type BillingEventInput,
  type BillingStatus,
  type BillingTransition,
} from "./club-billing-rules";

/**
 * Is the club this match belongs to paused for the club fee? For the Pi
 * routes that start from a WhatsApp message id (reactions, poll votes)
 * rather than a group. Always false, with no query, while BILLING_ENABLED
 * is off.
 */
export async function isMatchClubBillingPaused(matchId: string): Promise<boolean> {
  if (!isBillingEnabled()) return false;
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: { activity: { select: { org: { select: { billingStatus: true } } } } },
  });
  return !!m && isBillingPaused(m.activity.org);
}

export type SetBillingStateResult =
  | { ok: true; from: BillingStatus; to: BillingStatus; resumed: boolean }
  | { ok: false; reason: "not-found" | "no-change" | "raced" };

/** The ClubBilling fields a transition writes (never `trialEndsAt`). */
function billingPatch(from: string, t: BillingTransition, now: Date): Record<string, Date | string | null> {
  const patch: Record<string, Date | string | null> = {};
  if (t.to === "paused") {
    patch.pausedAt = now;
    patch.pausedReason = t.pausedReason;
  } else if (from === "paused") {
    patch.pausedAt = null;
    patch.pausedReason = null;
  }
  if (t.to === "subscribed") {
    // Paid (or a card is on): no grace is running, no failure is open.
    patch.graceEndsAt = null;
    patch.paymentFailedAt = null;
  }
  if (t.graceEndsAt) patch.graceEndsAt = t.graceEndsAt;
  if (t.paymentFailedAt) patch.paymentFailedAt = t.paymentFailedAt;
  return patch;
}

/**
 * Apply one billing event to one club, ALL OR NOTHING, in one transaction:
 *
 *   1. Lock the club: `SELECT ... FOR UPDATE` on its Organisation and
 *      ClubBilling rows. A Stripe webhook and the billing cron arriving
 *      together queue on the lock, and the second one decides on what the
 *      first one wrote (never on a stale read).
 *   2. Decide with the pure `nextBillingState`, from the locked rows.
 *   3. Write the status (with a compare-and-set as a second lock on the
 *      same door) and the ClubBilling fields.
 *   4. On a move out of "paused", run the resume work (`resumeClubTx`) in
 *      the SAME transaction: the club starts serving again only together
 *      with its stale jobs dropped and its stale matches quieted. If any
 *      of it fails, nothing is committed and the event can be retried.
 *
 * The free month starts at `approvedAt` for an approval (so the AI window
 * and the trial line up), at `now` for "Start free month". `trialEndsAt`
 * is written ONLY when the ClubBilling row is created, so it is never
 * reset, re-approval included.
 */
export async function setBillingState(
  orgId: string,
  event: BillingEventInput,
  now: Date = new Date(),
): Promise<SetBillingStateResult> {
  return db.$transaction(
    async (tx): Promise<SetBillingStateResult> => {
      const orgs = await tx.$queryRaw<Array<{ billingStatus: string; billingPlan: string; approvedAt: Date | null }>>`
        SELECT "billingStatus", "billingPlan", "approvedAt" FROM "Organisation" WHERE "id" = ${orgId} FOR UPDATE`;
      const org = orgs[0];
      if (!org) return { ok: false, reason: "not-found" };
      const billings = await tx.$queryRaw<
        Array<{ trialEndsAt: Date; graceEndsAt: Date | null; pausedReason: string | null }>
      >`SELECT "trialEndsAt", "graceEndsAt", "pausedReason" FROM "ClubBilling" WHERE "orgId" = ${orgId} FOR UPDATE`;

      const from = org.billingStatus;
      const t = nextBillingState(
        { approvedAt: org.approvedAt, billingStatus: from, billingPlan: org.billingPlan, billing: billings[0] ?? null },
        event,
        now,
      );
      if (!t) return { ok: false, reason: "no-change" };

      const { count } = await tx.organisation.updateMany({
        where: { id: orgId, billingStatus: from },
        data: { billingStatus: t.to },
      });
      if (count !== 1) {
        // Cannot happen under the row lock; kept as the second lock.
        console.log(`[club-billing] ${orgId}: ${event.type} lost the race (${from} changed underneath)`);
        return { ok: false, reason: "raced" };
      }

      if (t.createsBilling) {
        // `approvedAt` is never null here: nextBillingState refuses a club
        // that predates self-join.
        const start = event.type === "approved" ? (org.approvedAt ?? now) : now;
        await tx.clubBilling.create({ data: { orgId, ...trialWindow(start) } });
      } else {
        const patch = billingPatch(from, t, now);
        if (Object.keys(patch).length > 0) await tx.clubBilling.updateMany({ where: { orgId }, data: patch });
      }
      if (t.resumes) await resumeClubTx(tx, orgId, now);

      console.log(`[club-billing] ${orgId}: ${from} -> ${t.to} on ${event.type}`);
      return { ok: true, from: from as BillingStatus, to: t.to, resumed: t.resumes };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

/** Generous: the resume work touches a handful of rows per club. */
const TX_TIMEOUT_MS = 20_000;

/** The match states `completeFinishedMatches` would complete. */
const OPEN_MATCH_STATUSES: MatchStatus[] = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Bring a club back after a pause (4.4), in its own transaction. Normally
 * run by `setBillingState` inside the status change's transaction; this
 * export is for a manual re-run. Idempotent. See `resumeClubTx`.
 */
export async function resumeClub(
  orgId: string,
  now: Date = new Date(),
): Promise<{ droppedJobs: number; quietedMatches: number }> {
  return db.$transaction((tx) => resumeClubTx(tx, orgId, now), { timeout: TX_TIMEOUT_MS });
}

/**
 * The resume work (4.4), on a transaction client:
 *
 *   1. `resumedAt = now`.
 *   2. Drop stale work: unsent BotJobs already due (sendAfter null or
 *      past) and created before now are marked sent, so the first poll
 *      after the resume posts nothing queued before or during the pause.
 *      Future-dated personal reminders are kept.
 *   3. No catch-up posts. Every match that kicked off before the resume
 *      and could still have post-match work is quieted: an open one is
 *      completed (the completion cron skipped it while paused), and both
 *      open ones and ones completed in the last RESUME_QUIET_LOOKBACK_DAYS
 *      get `postMatchEndFlow = false` (no payment poll, unpaid reminders,
 *      the admins' unpaid list, rating DMs or MoM) and the score ask
 *      marked sent. So nothing about a match from before the resume
 *      reaches the group or the admins.
 *   4. Close the pick rounds and bench offers of matches that kicked off,
 *      exactly as the kickoff sweeps in due-posts would have while the
 *      club was paused. Rounds and offers for matches still to come stay
 *      open: the scheduler resumes them (and their fallback) as normal.
 *   5. Nothing is posted to announce the resume.
 */
async function resumeClubTx(
  tx: Tx,
  orgId: string,
  now: Date,
): Promise<{ droppedJobs: number; quietedMatches: number }> {
  await tx.clubBilling.updateMany({ where: { orgId }, data: { resumedAt: now } });

  const dropped = await tx.botJob.updateMany({
    where: {
      orgId,
      sentAt: null,
      createdAt: { lt: now },
      OR: [{ sendAfter: null }, { sendAfter: { lte: now } }],
    },
    data: { sentAt: now },
  });

  const since = new Date(now.getTime() - RESUME_QUIET_LOOKBACK_DAYS * DAY_MS);
  const stale = await tx.match.findMany({
    where: {
      activity: { orgId },
      date: { lte: now },
      OR: [
        { status: { in: OPEN_MATCH_STATUSES } },
        { status: "COMPLETED", postMatchEndFlow: true, date: { gte: since } },
      ],
    },
    select: { id: true },
  });
  let quieted = 0;
  if (stale.length > 0) {
    const ids = stale.map((m) => m.id);
    const res = await tx.match.updateMany({
      where: { id: { in: ids }, status: { in: [...OPEN_MATCH_STATUSES, "COMPLETED"] } },
      data: { status: "COMPLETED", postMatchEndFlow: false },
    });
    quieted = res.count;
    await tx.sentNotification.createMany({
      data: ids.map((id) => ({ key: `${id}:ask-score`, kind: "billing-resume-skip", matchId: id })),
      skipDuplicates: true,
    });
  }

  await tx.organiserPickRound.updateMany({
    where: { orgId, resolvedAt: null, match: { date: { lte: now } } },
    data: { resolvedAt: now, outcome: "closed-at-kickoff" },
  });
  await tx.benchSlotOffer.updateMany({
    where: { resolvedAt: null, match: { activity: { orgId }, date: { lte: now } } },
    data: { resolvedAt: now, outcome: "closed-at-kickoff" },
  });

  console.log(
    `[club-billing] resumed ${orgId}: dropped ${dropped.count} stale job(s), quieted ${quieted} match(es)`,
  );
  return { droppedJobs: dropped.count, quietedMatches: quieted };
}

const DAY_MS = 24 * 60 * 60 * 1000;
