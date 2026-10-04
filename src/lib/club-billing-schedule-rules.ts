/**
 * CLUB FEE BILLING, slice B4: WHEN the scheduler acts. PURE: no database,
 * no clock of its own (every function takes `now`).
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 4.1 and 6.
 *
 *   - The state changes happen ON TIME, whatever the hour: the free month
 *     ends at `trialEndsAt` ("trial-ended", to grace), the grace week at
 *     `graceEndsAt` ("grace-ended", to paused). `nextBillingState` in
 *     club-billing-rules.ts decides each one again under the club's row
 *     lock, so a webhook that got there first simply wins.
 *   - The DMs wait for DAYTIME: 10:00 to 20:00 London. The day 21 and day
 *     28 reminders are due from 10:00 London on their calendar day, which
 *     is counted back from the London date of `trialEndsAt` (so a free
 *     month that crosses a clock change, or started near midnight, still
 *     gets its reminder at 10:00 on the right day).
 *   - Each DM is claimed once per club, kind and cycle (`BillingNotice`),
 *     by the caller. A cron that was down for two days never sends two
 *     reminders in a row: day 21 is skipped once day 28 is due, and day 28
 *     then carries the club fee tip that day 21 would have.
 */
import { formatLondon, londonWallClockToUtc } from "./london-time";
import { GRACE_DAYS } from "./club-billing-rules";

/** Billing DMs go out from 10:00 London ... */
export const BILLING_DM_FROM_HOUR = 10;
/** ... until 20:00 London (exclusive). */
export const BILLING_DM_TO_HOUR = 20;
/** The day 21 reminder: 9 London calendar days before the free month ends. */
export const TRIAL_21_DAYS_BEFORE_END = 9;
/** The day 28 reminder: 2 London calendar days before it ends. */
export const TRIAL_28_DAYS_BEFORE_END = 2;
/** A pause older than this gets no "paused" DM any more (for example a
 *  club paused while the flag was off, or a DM that kept failing). */
export const PAUSED_DM_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** A pending payment, payer or resume DM older than this is never sent. */
export const PENDING_BILLING_DM_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * A "payment failed" DM waits this long after the failure before it goes,
 * so that when the same invoice also needs a bank check (3DS), whose DM
 * carries the link the payer actually needs, only that one is sent. Stripe
 * does not promise the order of the two events.
 */
export const PAYMENT_FAILED_HOLD_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function londonHour(now: Date): number {
  return Number(formatLondon(now, "H"));
}

/** Is it daytime in London (10:00 to 19:59), when billing DMs may go out? */
export function isBillingDmHour(now: Date): boolean {
  const h = londonHour(now);
  return h >= BILLING_DM_FROM_HOUR && h < BILLING_DM_TO_HOUR;
}

/**
 * The `sendAfter` for a billing DM queued at `now`: null in the daytime
 * (send at once), else the next 10:00 London.
 */
export function billingDmSendAfter(now: Date): Date | null {
  const h = londonHour(now);
  if (h >= BILLING_DM_FROM_HOUR && h < BILLING_DM_TO_HOUR) return null;
  // Before 10:00: today's 10:00. From 20:00: tomorrow's (12 hours on is
  // always tomorrow's London date, and never past tomorrow's 10:00 by more
  // than the 10:00 itself).
  const anchor = h < BILLING_DM_FROM_HOUR ? now : new Date(now.getTime() + 12 * HOUR_MS);
  return londonWallClockToUtc(anchor, `${String(BILLING_DM_FROM_HOUR).padStart(2, "0")}:00`);
}

/**
 * 10:00 London on the London calendar date `daysBefore` days before the
 * London date of `trialEndsAt`. Counting calendar days (not 24 hour
 * blocks) keeps the reminder at 10:00 across a clock change.
 */
export function reminderAt(trialEndsAt: Date, daysBefore: number): Date {
  const [y, m, d] = formatLondon(trialEndsAt, "yyyy-MM-dd").split("-").map(Number);
  // Noon UTC is the same calendar date in London, in winter and summer.
  const anchor = new Date(Date.UTC(y, m - 1, d - daysBefore, 12));
  return londonWallClockToUtc(anchor, `${String(BILLING_DM_FROM_HOUR).padStart(2, "0")}:00`);
}

/** What the scheduler reads about one billed club. */
export interface ScheduleClub {
  /** `Organisation.billingStatus`. */
  status: string;
  trialEndsAt: Date;
  graceEndsAt: Date | null;
  pausedAt: Date | null;
  pausedReason: string | null;
}

/** The state change due now, if any (it does not wait for daytime). */
export function billingTransitionDue(club: ScheduleClub, now: Date): "trial-ended" | "grace-ended" | null {
  if (club.status === "trial" && now >= club.trialEndsAt) return "trial-ended";
  if ((club.status === "grace" || club.status === "past_due") && club.graceEndsAt && now >= club.graceEndsAt) return "grace-ended";
  return null;
}

/** Grace that came from the free month ending (not from a payment
 *  failure or from being billed again after Free, which have their own DMs). */
function graceFromTrial(club: ScheduleClub): boolean {
  return !!club.graceEndsAt && club.graceEndsAt.getTime() === club.trialEndsAt.getTime() + GRACE_DAYS * DAY_MS;
}

export type ScheduledDmKind = "trial-21" | "trial-28" | "trial-ended" | "paused";

export interface DueDm {
  kind: ScheduledDmKind;
  /** The `BillingNotice` cycle: the free month's end for the trial DMs,
   *  the moment of the pause for "paused". */
  cycleKey: string;
  /** Carries the club fee tip paragraph (day 21, or day 28 when day 21
   *  never reached the contact). */
  withTip: boolean;
}

/**
 * The billing contact's DM due now for this club (at most one), or none.
 * Nothing at night: the caller runs hourly, so the 10:00 run sends it.
 *
 *   trial-21     from 10:00 London on day 21, still in the free month, and
 *                day 28 not yet due
 *   trial-28     from 10:00 London on day 28, still in the free month
 *   trial-ended  in the grace week that followed the free month
 *   paused       paused in the last 3 days (not after removal from the
 *                group, which is silent, slice B5)
 */
export function billingDmsDue(club: ScheduleClub, now: Date, opts: { trial21Delivered: boolean }): DueDm[] {
  if (!isBillingDmHour(now)) return [];
  const trialKey = club.trialEndsAt.toISOString();
  switch (club.status) {
    case "trial": {
      if (now >= club.trialEndsAt) return [];
      if (now >= reminderAt(club.trialEndsAt, TRIAL_28_DAYS_BEFORE_END)) {
        return [{ kind: "trial-28", cycleKey: trialKey, withTip: !opts.trial21Delivered }];
      }
      if (now >= reminderAt(club.trialEndsAt, TRIAL_21_DAYS_BEFORE_END)) {
        return [{ kind: "trial-21", cycleKey: trialKey, withTip: true }];
      }
      return [];
    }
    case "grace":
      if (!graceFromTrial(club) || now < club.trialEndsAt || now >= club.graceEndsAt!) return [];
      return [{ kind: "trial-ended", cycleKey: trialKey, withTip: false }];
    case "paused": {
      if (!club.pausedAt || club.pausedReason === "removed" || club.pausedReason === null) return [];
      if (now.getTime() - club.pausedAt.getTime() > PAUSED_DM_MAX_AGE_MS) return [];
      return [{ kind: "paused", cycleKey: club.pausedAt.toISOString(), withTip: false }];
    }
    default:
      return [];
  }
}

/**
 * The admin channel's club fee tip, once per free month (7.1, 7.2): due
 * with the day 21 reminder (or with day 28 when day 21 was missed), in
 * the daytime, while the club is still in its free month.
 */
export function feeTipDue(club: ScheduleClub, now: Date): { cycleKey: string } | null {
  if (!isBillingDmHour(now)) return null;
  if (club.status !== "trial" || now >= club.trialEndsAt) return null;
  if (now < reminderAt(club.trialEndsAt, TRIAL_21_DAYS_BEFORE_END)) return null;
  return { cycleKey: club.trialEndsAt.toISOString() };
}

// ── Slice P3 (games played): the cron's retries and the month DMs ───────

type Env = Record<string, string | undefined>;

/**
 * The cron's own retries of a failed month's invoice (plan 5.3): on days
 * 1, 3 and 5 after the close's first attempt, in the daytime, within the
 * 7 day payment grace. For an account whose automatic retries do not cover
 * one-off invoices; switched off with BILLING_CRON_RETRIES=0 once Stripe
 * test mode shows they do (plan 13.3, point 3).
 */
export const CRON_RETRY_DAYS = [1, 3, 5] as const;

/** `BILLING_CRON_RETRIES`: ON unless explicitly "0"/"false"/"off"/"no". */
export function cronRetriesEnabled(env: Env = process.env): boolean {
  const v = env.BILLING_CRON_RETRIES?.trim().toLowerCase();
  if (!v) return true;
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * The retry day due now for a month whose first attempt was at
 * `firstAttemptAt`, or null. Only the LATEST due day, and only when it is
 * later than every day already tried (`done`): after a cron outage the
 * missed days are not caught up one after another, and a day is never
 * tried twice.
 */
export function cronRetryDayDue(firstAttemptAt: Date, now: Date, done: readonly number[]): number | null {
  const elapsed = now.getTime() - firstAttemptAt.getTime();
  const due = CRON_RETRY_DAYS.filter((d) => elapsed >= d * DAY_MS);
  if (due.length === 0) return null;
  const latest = due[due.length - 1];
  return latest > Math.max(0, ...done) ? latest : null;
}

/** A month's DM (the receipt, "nothing to pay") is sent only while the
 *  month was closed or paid in the last 3 days: a DM about an old month
 *  (billing off for a while, a DM that kept failing) never goes. */
export const MONTH_DM_MAX_AGE_MS = 3 * DAY_MS;

export function monthDmFresh(m: { closedAt: Date | null; paidAt: Date | null }, now: Date): boolean {
  return [m.closedAt, m.paidAt].some((d) => d !== null && now.getTime() - d.getTime() <= MONTH_DM_MAX_AGE_MS);
}
