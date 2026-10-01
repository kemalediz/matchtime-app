/**
 * CLUB FEE BILLING: the PURE rules (no database import), slice B1.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 3, 4.1 to 4.5.
 *
 * Like club-approval-state.ts, this file has no database import, so the
 * gate helpers in club-approval-state.ts (`servingClubWhere`,
 * `isClubOperational`) can read the one definition of "paused", and every
 * rule is unit-testable with a fixed `now` and `env`.
 *
 *   - `billingStatus` on Organisation: "exempt" | "trial" | "grace" |
 *     "subscribed" | "past_due" | "paused". DEFAULT "exempt", so Sutton FC
 *     and every club that predates billing is never billed and never paused.
 *   - THE KILL SWITCH. `BILLING_ENABLED` is off unless explicitly on. Off
 *     means nobody counts as paused (`isBillingPaused` is false and
 *     `billingQuietWhere` is an empty fragment, so every gated query is
 *     exactly today's) and no free month starts. Turning it off brings any
 *     paused club straight back.
 *   - `nextBillingState` owns the transition table of section 4.2. The one
 *     writer, `setBillingState` in club-billing.ts, applies it.
 *   - `billingContact` decides who is asked for the card (4.5): the money
 *     collector, else the owner, else nobody.
 *
 * NOT the mute switch: billing never reads or writes `whatsappBotEnabled`.
 */

export const BILLING_STATUSES = ["exempt", "trial", "grace", "subscribed", "past_due", "paused"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_PLANS = ["standard", "free", "custom"] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

export const PAUSED_REASONS = ["no-card", "payment-failed", "cancelled", "removed"] as const;
export type PausedReason = (typeof PAUSED_REASONS)[number];

/** The free month, from approval. */
export const TRIAL_DAYS = 30;
/** Grace after the free month (no card) or after a failed payment. */
export const GRACE_DAYS = 7;
/** Card reminders (slice B4), as days after approval. */
export const REMINDER_DAYS = [21, 28] as const;
/**
 * On resume, matches completed this recently are quieted too (their
 * post-match flow switched off), so nothing about a match from before the
 * resume is posted. At least the scheduler's post-match lookback
 * (`POST_MATCH_LOOKBACK_DAYS` in bot-scheduler.ts, pinned by a test), which
 * covers every post-match window (payment poll, unpaid reminders, the
 * admins' unpaid list, rating DMs, MoM).
 */
export const RESUME_QUIET_LOOKBACK_DAYS = 10;
/** The signed-in billing link's life, in seconds (9 days, 4.5). */
export const BILLING_LINK_TTL = 9 * 24 * 60 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

// ── The kill switch ─────────────────────────────────────────────────────

/** `BILLING_ENABLED`: OFF unless explicitly "1"/"true"/"on"/"yes". */
export function isBillingEnabled(env: Env = process.env): boolean {
  const v = env.BILLING_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Is MatchTime quiet for this club because of billing? Only when the flag
 * is on AND the column says "paused". A row that did not select the column
 * (undefined) is never paused: going quiet needs a positive reason.
 */
export function isBillingPaused(
  org: { billingStatus?: string | null | undefined },
  env: Env = process.env,
): boolean {
  return isBillingEnabled(env) && org.billingStatus === "paused";
}

/** The fragment that keeps a paused club out of a query. */
export const BILLING_NOT_PAUSED_WHERE = { billingStatus: { not: "paused" } } as const;

/**
 * The Prisma `where` fragment to spread into an org lookup that must skip
 * a billing-paused club. An EMPTY object while the flag is off, so the
 * query is exactly today's (nothing to spread, nothing changes).
 */
export function billingQuietWhere(env: Env = process.env): typeof BILLING_NOT_PAUSED_WHERE | Record<string, never> {
  return isBillingEnabled(env) ? BILLING_NOT_PAUSED_WHERE : {};
}

/**
 * The same, for a query on a row that belongs to a MATCH (a bench offer,
 * a pick round): skip it when the match's club is billing-paused. Empty
 * while the flag is off.
 */
export function billingQuietMatchWhere(
  env: Env = process.env,
): { match: { activity: { org: typeof BILLING_NOT_PAUSED_WHERE } } } | Record<string, never> {
  return isBillingEnabled(env) ? { match: { activity: { org: BILLING_NOT_PAUSED_WHERE } } } : {};
}

// ── Dates ───────────────────────────────────────────────────────────────

export function trialWindow(start: Date): { trialStartedAt: Date; trialEndsAt: Date } {
  return { trialStartedAt: start, trialEndsAt: new Date(start.getTime() + TRIAL_DAYS * DAY_MS) };
}

export function graceEndsFrom(from: Date): Date {
  return new Date(from.getTime() + GRACE_DAYS * DAY_MS);
}

// ── The transition table (section 4.2) ──────────────────────────────────

/** What `nextBillingState` reads about a club. */
export interface BillingClub {
  /** When the club was approved through self-join. NULL for Sutton FC and
   *  every club that predates self-join: such a club is never billed. */
  approvedAt: Date | null;
  billingStatus: string;
  billingPlan: string;
  /** The ClubBilling row, or null when the club never had a free month. */
  billing: { trialEndsAt: Date; graceEndsAt: Date | null; pausedReason: string | null } | null;
}

export type BillingEventInput =
  /** decideClub approved the club (slice B2 wires it). */
  | { type: "approved" }
  /** The platform owner's "Start free month" on /admin/clubs (slice B2). */
  | { type: "start-trial" }
  /** Checkout completed: a card is on file (slice B3). */
  | { type: "card-added" }
  /** The scheduler at or after `trialEndsAt` (slice B4). */
  | { type: "trial-ended" }
  /** The scheduler at or after `graceEndsAt` (slice B4). */
  | { type: "grace-ended" }
  /** `invoice.payment_failed` (slice B3). */
  | { type: "payment-failed" }
  /** `invoice.paid` (slice B3). */
  | { type: "invoice-paid" }
  /** `customer.subscription.deleted` (slice B3). */
  | { type: "subscription-ended"; cancelAtPeriodEnd: boolean }
  /** Subscription status `unpaid`: Stripe gave up (slice B3). */
  | { type: "subscription-unpaid" }
  /** MatchTime removed from the club's group (slice B5). */
  | { type: "removed-from-group" }
  /** MatchTime re-added to the same group (slice B5). */
  | { type: "re-added" }
  /** The platform owner set plan Free (slice B2). */
  | { type: "plan-free" };

export interface BillingTransition {
  to: BillingStatus;
  /** Set exactly when `to` is "paused". */
  pausedReason: PausedReason | null;
  /** Create the ClubBilling row (the free month starts). */
  createsBilling: boolean;
  /** Moving out of "paused": `resumeClub` must run. */
  resumes: boolean;
  /** A new grace end to store, when the transition sets one. */
  graceEndsAt?: Date;
  /** The first failure of the current unpaid invoice. */
  paymentFailedAt?: Date;
}

const LIVE_BILLED: ReadonlySet<string> = new Set(["trial", "grace", "subscribed", "past_due"]);

function to(
  status: BillingStatus,
  from: string,
  extra: Partial<Omit<BillingTransition, "to" | "resumes">> = {},
): BillingTransition {
  return {
    to: status,
    pausedReason: extra.pausedReason ?? null,
    createsBilling: extra.createsBilling ?? false,
    resumes: from === "paused" && status !== "paused",
    ...(extra.graceEndsAt ? { graceEndsAt: extra.graceEndsAt } : {}),
    ...(extra.paymentFailedAt ? { paymentFailedAt: extra.paymentFailedAt } : {}),
  };
}

/**
 * The next billing state for an event, or null when the event does not
 * apply (no change). Section 4.2 is this function.
 *
 * A club that predates self-join (`approvedAt` NULL: Sutton FC and every
 * club approved by the column default) is NEVER moved, whatever the event
 * or its column says; a CHECK constraint holds the same line in the
 * database (prisma/sql/org-billing-check.sql).
 *
 * An "exempt" self-join club moves ONLY on "approved" or "start-trial",
 * and only with the flag on, a plan that is not Free and no earlier free
 * month. Every other event leaves it exempt, whatever Stripe or a cron says.
 */
export function nextBillingState(
  club: BillingClub,
  event: BillingEventInput,
  now: Date,
  env: Env = process.env,
): BillingTransition | null {
  const from = club.billingStatus;
  if (club.approvedAt === null || club.approvedAt === undefined) return null;
  if (!(BILLING_STATUSES as readonly string[]).includes(from)) return null;
  const b = club.billing;

  switch (event.type) {
    case "approved":
    case "start-trial":
      if (from !== "exempt" || b !== null) return null;
      if (club.billingPlan === "free") return null;
      if (!isBillingEnabled(env)) return null;
      return to("trial", from, { createsBilling: true });

    case "trial-ended":
      if (from !== "trial" || !b || now < b.trialEndsAt) return null;
      return to("grace", from, { graceEndsAt: graceEndsFrom(b.trialEndsAt) });

    case "grace-ended":
      if (!b?.graceEndsAt || now < b.graceEndsAt) return null;
      if (from === "grace") return to("paused", from, { pausedReason: "no-card" });
      if (from === "past_due") return to("paused", from, { pausedReason: "payment-failed" });
      return null;

    case "card-added":
      if (from === "trial" || from === "grace" || from === "paused") return to("subscribed", from);
      return null;

    case "payment-failed":
      if (from !== "subscribed") return null;
      return to("past_due", from, { graceEndsAt: graceEndsFrom(now), paymentFailedAt: now });

    case "invoice-paid":
      if (from === "past_due" || from === "paused") return to("subscribed", from);
      return null;

    case "subscription-ended":
      if (from !== "subscribed" && from !== "past_due") return null;
      return to("paused", from, { pausedReason: event.cancelAtPeriodEnd ? "cancelled" : "payment-failed" });

    case "subscription-unpaid":
      if (from !== "past_due") return null;
      return to("paused", from, { pausedReason: "payment-failed" });

    case "removed-from-group":
      if (!LIVE_BILLED.has(from)) return null;
      return to("paused", from, { pausedReason: "removed" });

    case "re-added":
      if (from !== "paused" || !b || b.pausedReason !== "removed" || now >= b.trialEndsAt) return null;
      return to("trial", from);

    case "plan-free":
      if (from === "exempt") return null;
      return to("exempt", from);
  }
}

// ── Who pays (section 4.5) ──────────────────────────────────────────────

export interface BillingMember {
  userId: string;
  role: string;
  leftAt: Date | null;
  phoneNumber: string | null;
}

export type BillingContact = { userId: string; via: "collector" | "owner" };

const hasPhone = (m: BillingMember) => typeof m.phoneNumber === "string" && m.phoneNumber.trim().length > 0;

/**
 * Who every card and payment DM goes to, worked out on demand (never
 * stored): the money collector when a current member with a phone, else
 * the first current OWNER with a phone (in the order given), else nobody.
 */
export function billingContact(
  org: { paymentHolderId: string | null },
  members: BillingMember[],
): BillingContact | null {
  if (org.paymentHolderId) {
    const collector = members.find((m) => m.userId === org.paymentHolderId && m.leftAt === null && hasPhone(m));
    if (collector) return { userId: collector.userId, via: "collector" };
  }
  const owner = members.find((m) => m.role === "OWNER" && m.leftAt === null && hasPhone(m));
  return owner ? { userId: owner.userId, via: "owner" } : null;
}
