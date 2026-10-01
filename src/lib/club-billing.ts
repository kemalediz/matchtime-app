/**
 * CLUB FEE BILLING: the one writer of `Organisation.billingStatus`, slice B1.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.2 and 4.4.
 *
 * ONE WRITER. Nothing outside this module may write `billingStatus`
 * (`__tests__/club-billing-source-guard.test.ts`). The transition table
 * lives in the pure `nextBillingState` (club-billing-rules.ts); this file
 * applies it with a compare-and-set on the current status, so a Stripe
 * webhook and the billing cron arriving together can never both act.
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
  nextBillingState,
  trialWindow,
  type BillingEventInput,
  type BillingStatus,
  type BillingTransition,
} from "./club-billing-rules";

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
 * Apply one billing event to one club. Returns what happened; never
 * throws for "nothing to do" (no-change) or a lost race (raced).
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
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      billingStatus: true,
      billingPlan: true,
      approvedAt: true,
      clubBilling: { select: { trialEndsAt: true, graceEndsAt: true, pausedReason: true } },
    },
  });
  if (!org) return { ok: false, reason: "not-found" };

  const from = org.billingStatus;
  const t = nextBillingState(
    { approvedAt: org.approvedAt, billingStatus: from, billingPlan: org.billingPlan, billing: org.clubBilling ?? null },
    event,
    now,
  );
  if (!t) return { ok: false, reason: "no-change" };

  const won = await db.$transaction(async (tx) => {
    const { count } = await tx.organisation.updateMany({
      where: { id: orgId, billingStatus: from },
      data: { billingStatus: t.to },
    });
    if (count !== 1) return false;

    if (t.createsBilling) {
      // `approvedAt` is never null here: nextBillingState refuses a club
      // that predates self-join.
      const start = event.type === "approved" ? (org.approvedAt ?? now) : now;
      await tx.clubBilling.create({ data: { orgId, ...trialWindow(start) } });
    } else {
      const patch = billingPatch(from, t, now);
      if (Object.keys(patch).length > 0) await tx.clubBilling.updateMany({ where: { orgId }, data: patch });
    }
    return true;
  });
  if (!won) {
    console.log(`[club-billing] ${orgId}: ${event.type} lost the race (${from} changed underneath)`);
    return { ok: false, reason: "raced" };
  }

  console.log(`[club-billing] ${orgId}: ${from} -> ${t.to} on ${event.type}`);
  if (t.resumes) await resumeClub(orgId, now);
  return { ok: true, from: from as BillingStatus, to: t.to, resumed: t.resumes };
}

/** The match states `completeFinishedMatches` would complete. */
const OPEN_MATCH_STATUSES: MatchStatus[] = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

/**
 * Bring a club back after a pause (4.4). Called by `setBillingState` on
 * any move out of "paused" (the status has already moved). Idempotent.
 *
 *   1. `resumedAt = now`.
 *   2. Drop stale work: unsent BotJobs that were already due (sendAfter
 *      null or past) and created before now are marked sent, so the first
 *      poll after the resume does not post something queued before the
 *      pause. Future-dated personal reminders are kept.
 *   3. No catch-up posts: matches that kicked off while the club was paused
 *      (the completion cron skipped them) are completed quietly, with
 *      `postMatchEndFlow = false` (no payment poll, rating DMs or MoM) and
 *      the score ask marked as already sent, so nothing about a match two
 *      weeks old reaches the group.
 *   4. Nothing is posted to announce the resume. The Pi picks the group up
 *      on its next org refresh.
 */
export async function resumeClub(
  orgId: string,
  now: Date = new Date(),
): Promise<{ droppedJobs: number; quietlyCompletedMatches: number }> {
  await db.clubBilling.updateMany({ where: { orgId }, data: { resumedAt: now } });

  const dropped = await db.botJob.updateMany({
    where: {
      orgId,
      sentAt: null,
      createdAt: { lt: now },
      OR: [{ sendAfter: null }, { sendAfter: { lte: now } }],
    },
    data: { sentAt: now },
  });

  const stale = await db.match.findMany({
    where: { activity: { orgId }, status: { in: OPEN_MATCH_STATUSES }, date: { lte: now } },
    select: { id: true },
  });
  let completed = 0;
  if (stale.length > 0) {
    const ids = stale.map((m) => m.id);
    const res = await db.match.updateMany({
      where: { id: { in: ids }, status: { in: OPEN_MATCH_STATUSES } },
      data: { status: "COMPLETED", postMatchEndFlow: false },
    });
    completed = res.count;
    await db.sentNotification.createMany({
      data: ids.map((id) => ({ key: `${id}:ask-score`, kind: "billing-resume-skip", matchId: id })),
      skipDuplicates: true,
    });
  }

  console.log(
    `[club-billing] resumed ${orgId}: dropped ${dropped.count} stale job(s), ` +
      `completed ${completed} match(es) quietly`,
  );
  return { droppedJobs: dropped.count, quietlyCompletedMatches: completed };
}
