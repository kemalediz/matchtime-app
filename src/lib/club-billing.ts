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
 * Callers: B2 wires approval (`decideClub`), the platform owner's plan
 * control (`setClubPlan`) and "Start free month" (`startTrial`); B3 the
 * webhook, B4 the cron, B5 removal from the group. Every club is "exempt"
 * by the column default, and an exempt club only ever moves on an
 * approval or "Start free month" with BILLING_ENABLED on.
 *
 * B2 also reads here for the web: the billing page's guard
 * (`requireClubBillingAccess`), the settings card, the banner and the
 * club fee tip. None of it calls Stripe.
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
import { PlatformDmRefused, queuePlatformDm } from "./platform-jobs";
import {
  RESUME_QUIET_LOOKBACK_DAYS,
  billingAccessRole,
  billingContact,
  clubFeeTip,
  isBillingEnabled,
  isBillingPaused,
  nextBillingState,
  startTrialRefusal,
  trialWindow,
  type BillingAccessRole,
  type BillingContact,
  type BillingEventInput,
  type BillingPlan,
  type BillingStatus,
  type BillingTransition,
  type ClubFeeTip,
  type StartTrialRefusal,
} from "./club-billing-rules";
import { bannerText, billingCardView, type BillingCardView } from "./club-billing-view";
import { BILLED_EVENT_TYPE, PAUSED_EVENT_TYPE, RESUMED_EVENT_TYPE, UNBILLED_EVENT_TYPE } from "./club-billing-cycle-rules";
import { loadMonthsSummary, loadUnpaidSummary } from "./club-billing-month-summary";

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
function billingPatch(
  from: string,
  t: BillingTransition,
  now: Date,
  fromReason: string | null = null,
): Record<string, Date | string | boolean | null> {
  const patch: Record<string, Date | string | boolean | null> = {};
  if (t.to === "paused") {
    patch.pausedAt = now;
    patch.pausedReason = t.pausedReason;
  } else if (from === "paused") {
    patch.pausedAt = null;
    patch.pausedReason = null;
    // Slice P2: billing starts again after Stop paying (Keep paying, or a
    // new card): that stop is over. Any other resume keeps a pending stop.
    // Into "exempt" (plan Free) the stop is REMEMBERED instead: the pause
    // reason is cleared, so `cancelAtPeriodEnd` is what tells "plan-billed"
    // later that the payer had stopped (test mode fix, 2026-10-05).
    if (fromReason === "cancelled") patch.cancelAtPeriodEnd = t.to === "exempt";
  }
  if (from === "exempt" && t.to !== "exempt") {
    // Billed again after Free ("plan-billed", slice B3): nothing from an
    // earlier billed spell may linger.
    patch.paymentFailedAt = null;
    if (t.to !== "paused") {
      patch.pausedAt = null;
      patch.pausedReason = null;
    }
    if (t.to === "trial") patch.graceEndsAt = null;
    // Back to subscribed with the card on file: nothing is stopped.
    if (t.to === "subscribed") patch.cancelAtPeriodEnd = false;
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
  opts: { noticeOnResume?: BillingNoticeKind } = {},
): Promise<SetBillingStateResult> {
  return db.$transaction((tx) => applyBillingEventTx(tx, orgId, event, now, opts), { timeout: TX_TIMEOUT_MS });
}

/**
 * `setBillingState`'s body, on a transaction client, so a caller that
 * must write more in the SAME transaction (the plan control's Free, B2)
 * shares the lock and the all-or-nothing. Locking a row this transaction
 * already holds is a no-op in Postgres.
 */
async function applyBillingEventTx(
  tx: Tx,
  orgId: string,
  event: BillingEventInput,
  now: Date,
  opts: { noticeOnResume?: BillingNoticeKind } = {},
): Promise<SetBillingStateResult> {
  const orgs = await tx.$queryRaw<Array<{ billingStatus: string; billingPlan: string; approvedAt: Date | null }>>`
    SELECT "billingStatus", "billingPlan", "approvedAt" FROM "Organisation" WHERE "id" = ${orgId} FOR UPDATE`;
  const org = orgs[0];
  if (!org) return { ok: false, reason: "not-found" };
  const billings = await tx.$queryRaw<
    Array<{
      trialEndsAt: Date;
      graceEndsAt: Date | null;
      pausedReason: string | null;
      stripePaymentMethodId?: string | null;
      cancelAtPeriodEnd?: boolean | null;
    }>
  >`SELECT "trialEndsAt", "graceEndsAt", "pausedReason", "stripePaymentMethodId", "cancelAtPeriodEnd" FROM "ClubBilling" WHERE "orgId" = ${orgId} FOR UPDATE`;
  const row = billings[0] ?? null;

  const from = org.billingStatus;
  const t = nextBillingState(
    {
      approvedAt: org.approvedAt,
      billingStatus: from,
      billingPlan: org.billingPlan,
      // A card on file is the Customer's saved default (`stripePaymentMethodId`);
      // the transitions out of exempt, trial and grace bill it instead of
      // asking for one (test mode fix, 2026-10-05).
      billing: row
        ? {
            trialEndsAt: row.trialEndsAt,
            graceEndsAt: row.graceEndsAt,
            pausedReason: row.pausedReason,
            hasCard: !!row.stripePaymentMethodId,
            stopped: !!row.cancelAtPeriodEnd,
          }
        : null,
    },
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

  // Slice P1 (plan 2A.3): the pause spans the games-played count reads.
  // Written after the compare-and-set and in the SAME transaction, so a
  // span exists exactly when the state change was committed. The matches
  // `resumeClubTx` completes quietly kicked off inside such a span and
  // are never counted as played.
  const spanEvent: "paused" | "resumed" | null =
    t.to === "paused" && from !== "paused" ? "paused" : from === "paused" && t.to !== "paused" ? "resumed" : null;
  // Slice P2 review (H1): the not-billable spells. Into "exempt" (plan
  // Free) the club stops being billable; out of it (billed again) it is
  // billable from now. Games inside the spell are never charged, and no
  // month that started inside it is ever opened.
  const spellEvent: "unbilled" | "billed" | null =
    t.to === "exempt" && from !== "exempt" ? "unbilled" : from === "exempt" && t.to !== "exempt" ? "billed" : null;
  const types = { paused: PAUSED_EVENT_TYPE, resumed: RESUMED_EVENT_TYPE, unbilled: UNBILLED_EVENT_TYPE, billed: BILLED_EVENT_TYPE } as const;
  for (const kind of [spanEvent, spellEvent]) {
    if (!kind) continue;
    await tx.billingEvent.create({
      data: { id: `mt_${kind}_${orgId}_${now.getTime()}`, type: types[kind], orgId, receivedAt: now, processedAt: now },
    });
  }

  if (t.createsBilling) {
    // `approvedAt` is never null here: nextBillingState refuses a club
    // that predates self-join.
    const start = event.type === "approved" ? (org.approvedAt ?? now) : now;
    await tx.clubBilling.create({ data: { orgId, ...trialWindow(start) } });
  } else {
    const patch = billingPatch(from, t, now, billings[0]?.pausedReason ?? null);
    if (Object.keys(patch).length > 0) await tx.clubBilling.updateMany({ where: { orgId }, data: patch });
  }
  if (t.resumes) {
    await resumeClubTx(tx, orgId, now);
    // A PENDING notice in the same transaction (review fix 10): the DM is
    // sent afterwards, and a crash or a failed send in between leaves it
    // pending for the retry, never lost.
    if (opts.noticeOnResume) {
      await tx.billingNotice.createMany({
        data: [{ orgId, kind: opts.noticeOnResume, cycleKey: now.toISOString() }],
        skipDuplicates: true,
      });
    }
  }

  console.log(`[club-billing] ${orgId}: ${from} -> ${t.to} on ${event.type}`);
  return { ok: true, from: from as BillingStatus, to: t.to, resumed: t.resumes };
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

// ── Slice B2: the platform owner's controls ─────────────────────────────

export type SetClubPlanResult =
  | {
      ok: true;
      plan: BillingPlan;
      pricePence: number | null;
      status: BillingStatus;
      resumed: boolean;
      /** Set when leaving Free billed the club again (its free month was
       *  already used): "trial" while that month is still running, else
       *  "grace" with a fresh 7 days. Slice B3. */
      /** Billed again after Free: "subscribed" (a card on file), "paused"
       *  (a card on file but the payer had stopped paying), else "trial" or
       *  "grace" (no card). */
      billedAgain: "trial" | "grace" | "subscribed" | "paused" | null;
    }
  | { ok: false; reason: "not-found" | "not-self-join" };

/**
 * The platform owner's plan control on /admin/clubs (8.3): Standard,
 * Free or Custom. ONE transaction holding the club's row lock, ordered so
 * every statement satisfies the CHECK constraints
 * (prisma/sql/org-billing-check.sql):
 *
 *   - to Free: the billing state goes to "exempt" FIRST (the "plan-free"
 *     event through `applyBillingEventTx`, which resumes a paused club in
 *     the same transaction), THEN the plan is written. The other order
 *     would break Organisation_billingFreeExempt_check;
 *   - leaving Free (or Standard and Custom between themselves): the plan
 *     first. A club that never had a free month stays "exempt" until the
 *     owner presses "Start free month". A club that HAD one is billed
 *     again in the same transaction ("plan-billed", slice B3): back to
 *     "trial" while its free month is still running, else "grace" with a
 *     fresh 7 days, and the caller asks the billing contact for a card.
 *     Pressing Standard again later (with the flag on) does the same, so
 *     no club is left exempt for ever by a Free spell.
 *
 * Refused for a club that predates self-join (`approvedAt` NULL, Sutton
 * FC): it is never billed, so it has no plan to change.
 *
 * Works with BILLING_ENABLED off too: Free only ever makes a club less
 * billed, and Standard or Custom on an exempt club bills nobody.
 * The months side (slice P2: on Free the open month is waived and unpaid
 * club fee invoices are voided; a price change is read by the month close)
 * is `onPlanChanged` in club-billing-stripe.ts, run by the caller after
 * this commits.
 */
export async function setClubPlan(
  orgId: string,
  choice: { plan: BillingPlan; pricePence: number | null },
  now: Date = new Date(),
): Promise<SetClubPlanResult> {
  return db.$transaction(
    async (tx): Promise<SetClubPlanResult> => {
      const orgs = await tx.$queryRaw<Array<{ billingStatus: string; billingPlan: string; approvedAt: Date | null }>>`
        SELECT "billingStatus", "billingPlan", "approvedAt" FROM "Organisation" WHERE "id" = ${orgId} FOR UPDATE`;
      const org = orgs[0];
      if (!org) return { ok: false, reason: "not-found" };
      if (org.approvedAt === null) return { ok: false, reason: "not-self-join" };

      let status = org.billingStatus as BillingStatus;
      let resumed = false;
      if (choice.plan === "free" && status !== "exempt") {
        const moved = await applyBillingEventTx(tx, orgId, { type: "plan-free" }, now);
        // Every non-exempt state moves to exempt on "plan-free"; anything
        // else would leave a Free plan on a billed club, which the CHECK
        // refuses. Throw, so nothing in this transaction is committed.
        if (!moved.ok) throw new Error(`[club-billing] ${orgId}: plan Free could not make the club exempt (${moved.reason})`);
        status = moved.to;
        resumed = moved.resumed;
        // WHEN the club stopped being billed, in the same transaction, for
        // the audit trail (B3 round-2 review N1).
        await tx.billingEvent.create({
          data: { id: `mt_exempt_${orgId}_${now.getTime()}`, type: EXEMPT_EVENT_TYPE, orgId, receivedAt: now, processedAt: now },
        });
      }
      const pricePence = choice.plan === "custom" ? choice.pricePence : null;
      await tx.organisation.update({ where: { id: orgId }, data: { billingPlan: choice.plan, billingPricePence: pricePence } });
      console.log(`[club-billing] ${orgId}: plan ${org.billingPlan} -> ${choice.plan}${pricePence ? ` (${pricePence}p)` : ""}`);

      // Slice B3, the B2 gap: an EXEMPT club that already had its free
      // month, set to Standard or Custom, is billed again (the plan is
      // written first, so the CHECK constraints hold at every statement).
      // `nextBillingState` refuses it with the flag off, for a club never
      // trialled (Start free month is its way in) and on Free.
      let billedAgain: "trial" | "grace" | "subscribed" | "paused" | null = null;
      if (choice.plan !== "free" && status === "exempt") {
        const moved = await applyBillingEventTx(tx, orgId, { type: "plan-billed" }, now);
        if (moved.ok && (moved.to === "trial" || moved.to === "grace" || moved.to === "subscribed" || moved.to === "paused")) {
          status = moved.to;
          billedAgain = moved.to;
          if (moved.to === "grace") {
            // The "plan-billed" DM, PENDING in this same transaction (review
            // fix 10): the action sends it after commit, and a retry finds
            // it still pending if that send failed.
            await tx.billingNotice.createMany({
              data: [{ orgId, kind: "plan-billed", cycleKey: now.toISOString() }],
              skipDuplicates: true,
            });
          }
        }
      }
      return { ok: true, plan: choice.plan, pricePence, status, resumed, billedAgain };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

export type StartTrialResult =
  | { ok: true; trialEndsAt: Date }
  | { ok: false; reason: StartTrialRefusal | "not-found" | "raced" };

/**
 * "Start free month" on /admin/clubs (8.3, decision 2), for a self-join
 * club approved before billing was switched on: the free month starts
 * NOW, once per club, through the one writer.
 */
export async function startTrial(orgId: string, now: Date = new Date()): Promise<StartTrialResult> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { billingStatus: true, billingPlan: true, approvedAt: true, clubBilling: { select: { trialEndsAt: true } } },
  });
  if (!org) return { ok: false, reason: "not-found" };
  const refusal = startTrialRefusal({
    approvedAt: org.approvedAt,
    billingStatus: org.billingStatus,
    billingPlan: org.billingPlan,
    hadFreeMonth: org.clubBilling !== null,
  });
  if (refusal) return { ok: false, reason: refusal };
  const r = await setBillingState(orgId, { type: "start-trial" }, now);
  if (!r.ok) return { ok: false, reason: r.reason === "not-found" ? "not-found" : "raced" };
  return { ok: true, trialEndsAt: trialWindow(now).trialEndsAt };
}

// ── Slice B2: the club fee tip, from the club's own games ───────────────

/**
 * The club fee tip's numbers for a club (7.2), or null when there is
 * nothing to cover (exempt, Free) or no such club. Reads the club's
 * ACTIVE weekly games, their sport's players per side and each one's
 * latest match fee.
 */
export async function loadClubFeeTip(orgId: string): Promise<ClubFeeTip | null> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      billingStatus: true,
      billingPlan: true,
      billingPricePence: true,
      sports: { select: { playersPerTeam: true }, orderBy: { createdAt: "asc" }, take: 1 },
      activities: {
        where: { isActive: true },
        select: {
          dayOfWeek: true,
          time: true,
          feePerPlayer: true,
          feeSplitTotal: true,
          sport: { select: { playersPerTeam: true } },
          matches: {
            where: { feePerPlayer: { not: null } },
            orderBy: { date: "desc" },
            take: 1,
            select: { feePerPlayer: true },
          },
        },
      },
    },
  });
  if (!org) return null;
  return clubFeeTip({
    status: org.billingStatus,
    plan: org.billingPlan,
    pricePence: org.billingPricePence,
    fallbackPlayersPerTeam: org.sports[0]?.playersPerTeam,
    activities: org.activities.map((a) => ({
      dayOfWeek: a.dayOfWeek,
      time: a.time,
      playersPerTeam: a.sport.playersPerTeam,
      feePerPlayer: a.feePerPlayer,
      feeSplitTotal: a.feeSplitTotal,
      latestMatchFee: a.matches[0]?.feePerPlayer ?? null,
    })),
  });
}

// ── Slice B2: who may open /billing/[orgId] (4.5) ───────────────────────

/** Thrown by `requireClubBillingAccess`: the page answers 404. */
export class BillingAccessDenied extends Error {
  constructor(orgId: string) {
    super(`No billing access to ${orgId}`);
    this.name = "BillingAccessDenied";
  }
}

/** Everything the billing page, the settings card and the guard read. */
export interface ClubBillingSnapshot {
  orgId: string;
  club: string;
  language: string;
  /** `Organisation.billingStatus`. */
  status: string;
  plan: string;
  pricePence: number | null;
  paymentHolderId: string | null;
  contact: (BillingContact & { name: string | null }) | null;
  billing: {
    trialEndsAt: Date;
    graceEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    cardBrand: string | null;
    cardLast4: string | null;
    cardHolderUserId: string | null;
    /** Slice B5: why a paused club is paused. */
    pausedReason: string | null;
  } | null;
  cardHolderName: string | null;
  members: Array<{ userId: string; role: string; leftAt: Date | null; name: string | null }>;
}

/** The club's billing as the web shows it, or null for no such club. */
export async function loadClubBillingSnapshot(orgId: string): Promise<ClubBillingSnapshot | null> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      language: true,
      billingStatus: true,
      billingPlan: true,
      billingPricePence: true,
      paymentHolderId: true,
      memberships: {
        orderBy: { createdAt: "asc" },
        select: { userId: true, role: true, leftAt: true, user: { select: { phoneNumber: true, name: true } } },
      },
      clubBilling: {
        select: {
          trialEndsAt: true,
          graceEndsAt: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          cardBrand: true,
          cardLast4: true,
          cardHolderUserId: true,
          pausedReason: true,
        },
      },
    },
  });
  if (!org) return null;
  const members = org.memberships.map((mb) => ({
    userId: mb.userId,
    role: mb.role as string,
    leftAt: mb.leftAt,
    phoneNumber: mb.user.phoneNumber,
    name: mb.user.name,
  }));
  const contact = billingContact({ paymentHolderId: org.paymentHolderId }, members);
  const nameOf = (id: string | null | undefined) => (id ? (members.find((mb) => mb.userId === id)?.name ?? null) : null);
  const holderId = org.clubBilling?.cardHolderUserId ?? null;
  let cardHolderName = nameOf(holderId);
  if (holderId && cardHolderName === null) {
    // An old card holder who has left the club is not in the member list.
    cardHolderName = (await db.user.findUnique({ where: { id: holderId }, select: { name: true } }))?.name ?? null;
  }
  return {
    orgId: org.id,
    club: org.name,
    language: org.language,
    status: org.billingStatus,
    plan: org.billingPlan,
    pricePence: org.billingPricePence,
    paymentHolderId: org.paymentHolderId,
    contact: contact ? { ...contact, name: nameOf(contact.userId) } : null,
    billing: org.clubBilling ?? null,
    cardHolderName,
    members: members.map(({ userId, role, leftAt, name }) => ({ userId, role, leftAt, name })),
  };
}

export interface BillingAccess {
  role: BillingAccessRole;
  snapshot: ClubBillingSnapshot;
}

/**
 * Who `userId` is to this club's billing (4.5), or null (the page is a
 * 404). `flagOn` is BILLING_ENABLED as the web reads it (the e2e cookie
 * seam, billing-flag.ts); it defaults to the environment.
 */
export async function loadBillingAccess(
  userId: string,
  orgId: string,
  opts: { flagOn?: boolean } = {},
): Promise<BillingAccess | null> {
  const flagOn = opts.flagOn ?? isBillingEnabled();
  if (!flagOn) return null;
  const snapshot = await loadClubBillingSnapshot(orgId);
  if (!snapshot) return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { isSuperadmin: true } });
  const mine = snapshot.members.find((mb) => mb.userId === userId) ?? null;
  const role = billingAccessRole({
    userId,
    flagOn,
    status: snapshot.status,
    isSuperadmin: !!user?.isSuperadmin,
    membership: mine ? { role: mine.role, leftAt: mine.leftAt } : null,
    contactUserId: snapshot.contact?.userId ?? null,
    cardHolderUserId: snapshot.billing?.cardHolderUserId ?? null,
  });
  return role ? { role, snapshot } : null;
}

/**
 * The guard for the billing page and (slice B3) every billing server
 * action, modelled on `requireMatchCollectorOrAdmin`: the billing
 * contact, an old card holder, or an OWNER or ADMIN (read only). Throws
 * `BillingAccessDenied` for anybody else, for an exempt club (there is
 * no billing to act on) and while BILLING_ENABLED is off. A server action
 * must call it itself, never trusting that the page was shown, and must
 * also refuse the role it does not serve (a "viewer" changes nothing).
 */
export async function requireClubBillingAccess(
  userId: string,
  orgId: string,
  opts: { flagOn?: boolean } = {},
): Promise<BillingAccess & { role: Exclude<BillingAccessRole, "exempt-owner"> }> {
  const access = await loadBillingAccess(userId, orgId, opts);
  if (!access || access.role === "exempt-owner") throw new BillingAccessDenied(orgId);
  return access as BillingAccess & { role: Exclude<BillingAccessRole, "exempt-owner"> };
}

// ── Slice B2: the settings card and the banner (8.1, 8.2) ───────────────

/**
 * The /admin/settings billing card for a club, or null: with the web's
 * flag off, and for an exempt club (Sutton FC sees nothing new). The
 * caller has already checked the viewer is an OWNER or ADMIN.
 */
export async function loadBillingCard(
  orgId: string,
  opts: { flagOn?: boolean } = {},
): Promise<(BillingCardView & { billingPath: string }) | null> {
  if (!(opts.flagOn ?? isBillingEnabled())) return null;
  const snapshot = await loadClubBillingSnapshot(orgId);
  if (!snapshot || snapshot.status === "exempt") return null;
  const now = new Date();
  // Slice P4: this month so far and the last closed month (no receipts:
  // the card is the admins' read-only view).
  const months = await loadMonthsSummary(orgId, {
    now,
    plan: snapshot.plan,
    pricePence: snapshot.pricePence,
    role: "viewer",
    viewerUserId: "",
    cardHolderUserId: null,
    take: 1,
  });
  const view = billingCardView(snapshot.language, snapshot, await loadClubFeeTip(orgId), { now, months });
  return view ? { ...view, billingPath: `/billing/${orgId}` } : null;
}

/** The admin banner's line for a club (grace, past due, paused), or null. */
export async function loadBillingBanner(orgId: string, opts: { flagOn?: boolean } = {}): Promise<string | null> {
  if (!(opts.flagOn ?? isBillingEnabled())) return null;
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: {
      language: true,
      billingStatus: true,
      clubBilling: { select: { trialEndsAt: true, graceEndsAt: true, pausedReason: true } },
    },
  });
  if (!org) return null;
  return bannerText(org.language, {
    status: org.billingStatus,
    trialEndsAt: org.clubBilling?.trialEndsAt ?? null,
    graceEndsAt: org.clubBilling?.graceEndsAt ?? null,
    pausedReason: org.clubBilling?.pausedReason ?? null,
    // Slice P4: the past due banner names the unpaid month and its amount.
    unpaid: org.billingStatus === "past_due" ? await loadUnpaidSummary(orgId) : null,
  });
}

// ── Slice B3: the billing DMs (claimed once, then queued) ───────────────

/** The billing contact's user id (4.5): the money collector, else the
 *  owner, else null. Resolved now, never stored. */
export async function loadBillingContactUserId(orgId: string): Promise<string | null> {
  const snapshot = await loadClubBillingSnapshot(orgId);
  return snapshot?.contact?.userId ?? null;
}

export type BillingNoticeKind =
  | "card-added"
  | "card-replaced"
  | "resumed"
  | "plan-billed"
  | "trial-21"
  | "trial-28"
  | "trial-ended"
  | "paused"
  | "payment-failed"
  /** A bank check (3DS) on an invoice (slice B4). */
  | "payment-action"
  | "payer-changed"
  | "fee-tip"
  /** Slice P3 (games played), keyed by the month's id: the receipt once
   *  its invoice is paid, and the first month in a row with no games. */
  | "month-charged"
  | "month-free"
  /** Slice P3: Keep paying ("undo:<stop date>" or "restart:<pause>"). */
  | "keep-paying";

/** `BillingNotice.platformJobId` values: NULL is PENDING (written by a
 *  state change, not sent yet); "claimed:<ISO time>" while a sender holds
 *  it; "skipped:<why>" can never be sent; anything else is the PlatformJob
 *  id. A claim older than CLAIM_STALE_MS was left by a sender that died
 *  (round-2 review N6) and may be taken over. */
const CLAIM_PREFIX = "claimed:";
export const CLAIM_STALE_MS = 10 * 60 * 1000;

function staleClaim(value: string | null, now: number): boolean {
  if (!value?.startsWith(CLAIM_PREFIX)) return false;
  const at = Date.parse(value.slice(CLAIM_PREFIX.length));
  return Number.isFinite(at) && now - at > CLAIM_STALE_MS;
}

/**
 * Queue ONE billing DM on the platform channel (purpose "billing"), to
 * one club member's own phone. CLAIM FIRST, THEN QUEUE, on the
 * `BillingNotice(orgId, kind, cycleKey)` row:
 *
 *   - a new row is created already claimed; an existing PENDING row (no
 *     platformJobId: a state change wrote it in its own transaction) or a
 *     STALE claim (older than 10 minutes: its sender died) is taken with a
 *     compare-and-set; anything else is "already";
 *   - queued: the row holds the PlatformJob id, so it is never sent twice;
 *   - queueing THREW: the claim is RELEASED (back to pending) and the error
 *     rethrown, so the retried webhook or action sends it;
 *   - the recipient cannot be messaged: marked skipped, never retried.
 *
 * The only queuer of purpose "billing" (source guard). `text` is built
 * with the recipient's name, in the club's language by the caller.
 */
export async function queueBillingDm(args: {
  orgId: string;
  kind: BillingNoticeKind;
  cycleKey: string;
  userId: string;
  text: (recipient: { name: string | null }) => string;
  sendAfter?: Date | null;
}): Promise<"queued" | "already" | "no-phone" | "refused"> {
  const where = { orgId: args.orgId, kind: args.kind, cycleKey: args.cycleKey };
  const claim = `${CLAIM_PREFIX}${new Date().toISOString()}`;
  let claimed = false;
  try {
    await db.billingNotice.create({ data: { ...where, platformJobId: claim }, select: { id: true } });
    claimed = true;
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
  if (!claimed) {
    const row = await db.billingNotice.findFirst({ where, select: { platformJobId: true } });
    const current = row?.platformJobId ?? null;
    if (row && (current === null || staleClaim(current, Date.now()))) {
      const { count } = await db.billingNotice.updateMany({ where: { ...where, platformJobId: current }, data: { platformJobId: claim } });
      claimed = count === 1;
      if (claimed && current !== null) console.warn(`[club-billing] ${args.orgId}: ${args.kind} took over a stale claim (${current})`);
    }
    if (!claimed) return "already";
  }
  const mark = (platformJobId: string | null) =>
    db.billingNotice.updateMany({ where: { ...where, platformJobId: claim }, data: { platformJobId } });

  try {
    const user = await db.user.findUnique({ where: { id: args.userId }, select: { name: true, phoneNumber: true } });
    if (!user?.phoneNumber) {
      await mark("skipped:no-phone");
      console.warn(`[club-billing] ${args.orgId}: ${args.kind} DM not sent, ${args.userId} has no phone`);
      return "no-phone";
    }
    const job = await queuePlatformDm({
      phone: user.phoneNumber,
      text: args.text({ name: user.name }),
      purpose: "billing",
      refId: `${args.orgId}:${args.kind}:${args.cycleKey}`,
      sendAfter: args.sendAfter ?? null,
    });
    await mark(job.id);
    console.log(`[club-billing] ${args.orgId}: ${args.kind} DM queued to ${args.userId}`);
    return "queued";
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      await mark("skipped:refused");
      console.warn(`[club-billing] ${args.orgId}: ${args.kind} DM refused: ${err.reason}`);
      return "refused";
    }
    await mark(null).catch(() => undefined); // release: the retry sends it
    throw err;
  }
}

/** Never send this pending notice (stale, superseded, no longer true, or
 *  nobody to send it to). Only a still-pending row is touched. */
export async function skipBillingNotice(orgId: string, kind: BillingNoticeKind, cycleKey: string, why: string): Promise<void> {
  await db.billingNotice.updateMany({ where: { orgId, kind, cycleKey, platformJobId: null }, data: { platformJobId: `skipped:${why}` } });
}

/** BillingEvent rows MatchTime writes itself (ids "mt_..." never collide
 *  with Stripe's "evt_..."). */
export const EXEMPT_EVENT_TYPE = "mt.club-exempt";

/** The pending (written, not yet sent) notices of the kinds a state change
 *  leaves behind, for the caller to send (`flushPendingBillingNotices`). */
export async function loadPendingBillingNotices(
  orgId: string,
): Promise<Array<{ kind: BillingNoticeKind; cycleKey: string; createdAt: Date }>> {
  const rows = await db.billingNotice.findMany({
    where: { orgId, platformJobId: null, kind: { in: ["plan-billed", "resumed", "card-added", "card-replaced", "keep-paying"] } },
    select: { kind: true, cycleKey: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ kind: r.kind as BillingNoticeKind, cycleKey: r.cycleKey, createdAt: r.createdAt }));
}

/**
 * Note a billing DM as PENDING (slice B4): a DM that became due at night
 * is not queued for the morning blindly; the 10:00 run re-checks it is
 * still true and sends it (`flushPendingBillingNotices`). Once per club,
 * kind and cycle, like every billing notice.
 */
export async function notePendingBillingNotice(orgId: string, kind: BillingNoticeKind, cycleKey: string, now: Date): Promise<void> {
  await db.billingNotice.createMany({ data: [{ orgId, kind, cycleKey, createdAt: now }], skipDuplicates: true });
}
