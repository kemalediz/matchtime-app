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
  billing: {
    trialEndsAt: Date;
    graceEndsAt: Date | null;
    pausedReason: string | null;
    /**
     * A card is on file (`stripePaymentMethodId`: the Customer's saved
     * default, which a Free spell does not remove). Test mode, 2026-10-05: a
     * club with a card set Free and back went trial, grace, then paused for
     * "no card". With a card it is billed with that card instead.
     */
    hasCard?: boolean;
    /** The payer pressed Stop paying (`cancelAtPeriodEnd`). */
    stopped?: boolean;
  } | null;
}

export type BillingEventInput =
  /** decideClub approved the club (slice B2 wires it). */
  | { type: "approved" }
  /** The platform owner's "Start free month" on /admin/clubs (slice B2). */
  | { type: "start-trial" }
  /**
   * A card was saved (Checkout in setup mode completed; slice P2), or the
   * payer pressed "Keep paying" on a club paused after Stop paying. Nothing
   * is charged by it. `unpaid`: a club fee invoice of an earlier month is
   * still unpaid, so a club paused for a failed payment stays paused until
   * that invoice is paid (`invoice-paid` resumes it).
   */
  | { type: "card-added"; unpaid?: boolean }
  /** The scheduler at or after `trialEndsAt` (slice B4). */
  | { type: "trial-ended" }
  /** The scheduler at or after `graceEndsAt` (slice B4). */
  | { type: "grace-ended" }
  /** `invoice.payment_failed` on a month's club fee invoice. */
  | { type: "payment-failed" }
  /** `invoice.paid` on a month's club fee invoice, with no other unpaid. */
  | { type: "invoice-paid" }
  /**
   * P2 review (M3): the unpaid invoice was forgiven (voided, or marked
   * uncollectible) and nothing else is unpaid: the club is no longer owing,
   * so past due, or paused FOR THAT payment, goes back to subscribed.
   */
  | { type: "unpaid-cleared" }
  /**
   * Slice P2: billing ends because the payer pressed Stop paying. Inside
   * the free month (the card has just been removed) the club goes back to
   * "trial" with the same end date; otherwise the month close of the last
   * month pauses it ("cancelled").
   */
  | { type: "billing-stopped" }
  /** MatchTime removed from the club's group (slice B5). */
  | { type: "removed-from-group" }
  /**
   * MatchTime re-added to the same group (slice B5), with what OUR rows say
   * about paying (slice P2): "ok" (a card on file and no club fee invoice
   * unpaid), "unpaid" (a club fee invoice is unpaid), or null (no card).
   */
  | { type: "re-added"; card?: "ok" | "unpaid" | null }
  /** The platform owner set plan Free (slice B2). */
  | { type: "plan-free" }
  /**
   * The platform owner set Standard or Custom on an EXEMPT club that has
   * already had its free month (slice B3; the B2 review gap: a club set to
   * Free and back would otherwise stay exempt for ever, because "Start free
   * month" refuses a second free month). Back to "trial" while the original
   * free month is still running, else "grace" with a fresh 7 days from now.
   * With a card on file: "subscribed" at once (or paused "cancelled" when
   * the payer had pressed Stop paying).
   */
  | { type: "plan-billed" };

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
      // A card on file: billed with it, never a "no card" grace.
      if (b.hasCard) return to("subscribed", from);
      return to("grace", from, { graceEndsAt: graceEndsFrom(b.trialEndsAt) });

    case "grace-ended":
      if (!b?.graceEndsAt || now < b.graceEndsAt) return null;
      // The "no card" grace ends with a card on file: billed with it.
      if (from === "grace" && b.hasCard) return to("subscribed", from);
      if (from === "grace") return to("paused", from, { pausedReason: "no-card" });
      if (from === "past_due") return to("paused", from, { pausedReason: "payment-failed" });
      return null;

    case "card-added":
      if (from === "trial" || from === "grace") return to("subscribed", from);
      if (from === "paused") {
        // Removed from the group: adding MatchTime back is the way, never a
        // card (it would pay for a group MatchTime is not in).
        if (b?.pausedReason === "removed") return null;
        // A failed payment: the card alone does not resume it while that
        // invoice is unpaid; paying it does (invoice-paid).
        if (b?.pausedReason === "payment-failed" && event.unpaid) return null;
        return to("subscribed", from);
      }
      return null;

    case "payment-failed":
      if (from !== "subscribed") return null;
      return to("past_due", from, { graceEndsAt: graceEndsFrom(now), paymentFailedAt: now });

    case "invoice-paid":
      if (from === "past_due" || from === "paused") return to("subscribed", from);
      return null;

    case "unpaid-cleared":
      if (from === "past_due") return to("subscribed", from);
      if (from === "paused" && b?.pausedReason === "payment-failed") return to("subscribed", from);
      return null;

    case "billing-stopped":
      // Slice P3 (P2 review LOW 4): the stop comes due while the club is
      // paused for a failed payment (that payment then arrives, or is
      // forgiven): it stays paused, now because billing stopped. Never a
      // resume on the way.
      if (from === "paused" && b?.pausedReason === "payment-failed") return to("paused", from, { pausedReason: "cancelled" });
      if (from !== "subscribed" && from !== "past_due") return null;
      // Stopped inside the free month (the card has just been removed): the
      // free month carries on with the same end date and its reminders.
      if (from === "subscribed" && b && now < b.trialEndsAt) return to("trial", from);
      return to("paused", from, { pausedReason: "cancelled" });

    case "removed-from-group":
      if (!LIVE_BILLED.has(from)) return null;
      return to("paused", from, { pausedReason: "removed" });

    case "re-added":
      // Only a club paused BECAUSE it was removed; any other pause has its
      // own way back (a card, a payment).
      if (from !== "paused" || !b || b.pausedReason !== "removed") return null;
      // A card on file and nothing unpaid: serving again at once.
      if (event.card === "ok") return to("subscribed", from);
      // A club fee invoice is unpaid: still paused, now waiting for the
      // payment, so "Update card and pay" and the paid invoice resume it.
      if (event.card === "unpaid") return to("paused", from, { pausedReason: "payment-failed" });
      // No card, free month still running: back to the free month.
      if (now < b.trialEndsAt) return to("trial", from);
      // No card, free month over: still paused, now waiting for a card, so
      // Add a card resumes it as usual.
      return to("paused", from, { pausedReason: "no-card" });

    case "plan-free":
      if (from === "exempt") return null;
      return to("exempt", from);

    case "plan-billed":
      if (from !== "exempt" || !b) return null;
      if (club.billingPlan === "free") return null;
      if (!isBillingEnabled(env)) return null;
      if (b.hasCard) {
        // The payer had stopped paying: still stopped. "Keep paying" (Start
        // again) is their way back; the card is never charged without it.
        if (b.stopped) return to("paused", from, { pausedReason: "cancelled" });
        // Billed with the card on file at once, in or after the free month
        // (a card in the free month is "subscribed", as after Add a card;
        // month 1 still starts when the free month ends). Never asked for a
        // card it already has.
        return to("subscribed", from);
      }
      if (now < b.trialEndsAt) return to("trial", from);
      return to("grace", from, { graceEndsAt: graceEndsFrom(now) });

    default:
      // An event this table does not know (a retired subscription event):
      // no change.
      return null;
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

// ── Prices and the plan control (slice B2, 8.3; decisions 9 and 13) ─────

/** Standard plan: GBP 9.99 a month, VAT included. */
export const STANDARD_PRICE_PENCE = 999;
/** Custom plan range (the CHECK constraint holds the same line). */
export const CUSTOM_PRICE_MIN_PENCE = 100;
export const CUSTOM_PRICE_MAX_PENCE = 999;

/** The monthly price a plan charges, or null for Free (and for a custom
 *  plan with no price, which the CHECK constraint forbids anyway). */
export function planPricePence(plan: string, pricePence: number | null): number | null {
  if (plan === "standard") return STANDARD_PRICE_PENCE;
  if (plan === "custom") return pricePence ?? null;
  return null;
}

export type PlanChoice =
  | { ok: true; plan: BillingPlan; pricePence: number | null }
  | { ok: false; reason: "unknown-plan" | "bad-price" | "out-of-range" };

/**
 * The platform owner's plan control, parsed. Custom takes pounds as typed
 * ("5", "5.50", "£5.50"), GBP 1.00 to GBP 9.99, whole pence. Standard and
 * Free ignore any price.
 */
export function parsePlanChoice(input: { plan: string; price?: string | null }): PlanChoice {
  const plan = input.plan;
  if (plan === "standard" || plan === "free") return { ok: true, plan, pricePence: null };
  if (plan !== "custom") return { ok: false, reason: "unknown-plan" };
  const raw = (input.price ?? "").trim().replace(/^£/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return { ok: false, reason: "bad-price" };
  const pence = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (pence < CUSTOM_PRICE_MIN_PENCE || pence > CUSTOM_PRICE_MAX_PENCE) return { ok: false, reason: "out-of-range" };
  return { ok: true, plan: "custom", pricePence: pence };
}

// ── The club fee tip (slice B2, 7.2; decisions 15 and 16) ───────────────

/** Games a month per weekly game slot: every month counts as four weeks. */
export const GAMES_PER_WEEKLY_SLOT = 4;
/** The neutral example match fee when the club has none (GBP 8). */
export const EXAMPLE_FEE_PENCE = 800;
/** The share is rounded UP to the next multiple of this, never below it. */
export const SHARE_STEP_PENCE = 5;
/** Two activities on the same weekday within this many minutes are one
 *  game slot (a format-switch pair), as generate-matches dedupes them
 *  (`SLOT_TIME_TOLERANCE_MS` in match-slot.ts). */
export const SLOT_TOLERANCE_MINUTES = 90;

/** One ACTIVE weekly activity, as the tip reads it. Fees in pounds, as
 *  `Activity.feePerPlayer` and `Match.feePerPlayer` store them. */
export interface TipActivity {
  dayOfWeek: number;
  /** "HH:MM". */
  time: string;
  playersPerTeam: number;
  feePerPlayer: number | null;
  feeSplitTotal: boolean;
  /** The latest match's base fee for this activity, when one was set. */
  latestMatchFee: number | null;
}

export interface ClubFeeTipInput {
  /** The club's billing state (`Organisation.billingStatus`). */
  status: string;
  plan: string;
  pricePence: number | null;
  activities: TipActivity[];
  /** Players per side when the club has no active activity (default 5). */
  fallbackPlayersPerTeam?: number;
}

export interface ClubFeeTip {
  pricePence: number;
  /** Players per side of the club's (first) weekly game. */
  perSide: number;
  /** Players in that game (2 x per side). */
  players: number;
  /** Games a month: 4 per weekly slot, at least 4. */
  games: number;
  /** Slice P3 (games played): the most one game played costs the club,
   *  the monthly price over the month's games, rounded UP to the penny
   *  (GBP 2.50 for GBP 9.99 and one weekly game). */
  perGamePence: number;
  /** The share per player per game, rounded up to the next 5p. */
  sharePence: number;
  /** The example match fee and the fee with the share added. */
  feePence: number;
  feePlusPence: number;
  feeSource: "own" | "latest-match" | "example";
  /** The club splits the pitch cost (`feeSplitTotal`). */
  split: boolean;
}

function minutesOf(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/**
 * The weekly game slots: activities grouped by weekday, two within
 * SLOT_TOLERANCE_MINUTES of each other counting once. Each slot is
 * represented by its SMALLEST game (fewest players), so a format-switch
 * pair never understates the share. Ordered by weekday, then time.
 */
function weeklySlots(activities: TipActivity[]): TipActivity[] {
  const sorted = [...activities].sort((a, b) => a.dayOfWeek - b.dayOfWeek || minutesOf(a.time) - minutesOf(b.time));
  const slots: Array<{ day: number; start: number; rep: TipActivity }> = [];
  for (const a of sorted) {
    const at = minutesOf(a.time);
    const slot = slots.find((s) => s.day === a.dayOfWeek && Math.abs(at - s.start) <= SLOT_TOLERANCE_MINUTES);
    if (!slot) slots.push({ day: a.dayOfWeek, start: at, rep: a });
    else if (a.playersPerTeam < slot.rep.playersPerTeam) slot.rep = a;
  }
  return slots.map((s) => s.rep);
}

/**
 * The club fee tip's numbers (7.2), or null when there is nothing to
 * cover (an exempt club, or the Free plan).
 *
 *   players per game   2 x playersPerTeam
 *   games a month      4 per weekly slot (4 when there is none)
 *   per game           price / games, rounded UP to the penny: the most
 *                      a game played costs (slice P3, games played)
 *   share              price / player-games in a month, rounded UP to the
 *                      next 5p and never below 5p
 *   example fee        the activity's own fee, else its latest match fee,
 *                      else GBP 8
 */
export function clubFeeTip(input: ClubFeeTipInput): ClubFeeTip | null {
  if (input.status === "exempt") return null;
  const price = planPricePence(input.plan, input.pricePence);
  if (price === null) return null;

  const slots = weeklySlots(input.activities);
  const first = slots[0] ?? null;
  const perSide = first?.playersPerTeam ?? input.fallbackPlayersPerTeam ?? 5;
  const playerGames =
    slots.length > 0
      ? slots.reduce((sum, s) => sum + GAMES_PER_WEEKLY_SLOT * 2 * s.playersPerTeam, 0)
      : GAMES_PER_WEEKLY_SLOT * 2 * perSide;
  // Integer ceiling of price / (playerGames x 5p), in whole 5p steps.
  const step = playerGames * SHARE_STEP_PENCE;
  const sharePence = Math.max(SHARE_STEP_PENCE, Math.floor((price + step - 1) / step) * SHARE_STEP_PENCE);

  const own = first?.feePerPlayer ?? null;
  const latest = first?.latestMatchFee ?? null;
  const feeSource: ClubFeeTip["feeSource"] = own !== null && own > 0 ? "own" : latest !== null && latest > 0 ? "latest-match" : "example";
  const feePence = feeSource === "own" ? Math.round(own! * 100) : feeSource === "latest-match" ? Math.round(latest! * 100) : EXAMPLE_FEE_PENCE;

  const games = Math.max(1, slots.length) * GAMES_PER_WEEKLY_SLOT;
  return {
    pricePence: price,
    perSide,
    players: 2 * perSide,
    games,
    perGamePence: Math.ceil(price / games),
    sharePence,
    feePence,
    feePlusPence: feePence + sharePence,
    feeSource,
    split: first?.feeSplitTotal ?? false,
  };
}

// ── Who may open the billing page (slice B2, 4.5) ───────────────────────

/**
 *   "contact"       the billing contact (the money collector, else the
 *                   owner): the full page, every card button;
 *   "card-holder"   whoever's card is on file but is no longer the
 *                   contact: one button, Remove my card;
 *   "viewer"        an OWNER or ADMIN (or the platform superadmin) who is
 *                   neither: the status and the tip, no buttons;
 *   "exempt-owner"  the club is exempt (Sutton FC's shape): its OWNER (or
 *                   the superadmin) sees an "exempt" label and nothing else.
 */
export type BillingAccessRole = "contact" | "card-holder" | "viewer" | "exempt-owner";

export interface BillingAccessInput {
  userId: string;
  /** BILLING_ENABLED, as the web reads it. Off: nobody gets anything. */
  flagOn: boolean;
  /** The club's `billingStatus`. */
  status: string;
  isSuperadmin: boolean;
  /** The user's membership of THIS club, or null. */
  membership: { role: string; leftAt: Date | null } | null;
  /** `billingContact(...)`'s user id, or null when there is none. */
  contactUserId: string | null;
  /** `ClubBilling.cardHolderUserId`. */
  cardHolderUserId: string | null;
}

/** Who this user is to the club's billing, or null (the page is a 404). */
export function billingAccessRole(input: BillingAccessInput): BillingAccessRole | null {
  if (!input.flagOn) return null;
  const current = input.membership && input.membership.leftAt === null ? input.membership : null;
  if (input.status === "exempt") {
    return input.isSuperadmin || current?.role === "OWNER" ? "exempt-owner" : null;
  }
  if (input.contactUserId !== null && input.contactUserId === input.userId) return "contact";
  if (input.cardHolderUserId !== null && input.cardHolderUserId === input.userId) return "card-holder";
  if (input.isSuperadmin || current?.role === "OWNER" || current?.role === "ADMIN") return "viewer";
  return null;
}

// ── "Start free month" (slice B2, 8.3; decision 2) ──────────────────────

export type StartTrialRefusal = "not-self-join" | "flag-off" | "not-exempt" | "had-free-month" | "plan-free";

/**
 * Why "Start free month" cannot start one, or null when it can. The same
 * line `nextBillingState` holds for "start-trial", spelled out so the
 * platform owner's page can say which. The free month happens once per
 * club (`trialEndsAt` is never reset), so a club that had one, or is
 * already billed, is refused.
 */
export function startTrialRefusal(
  club: { approvedAt: Date | null; billingStatus: string; billingPlan: string; hadFreeMonth: boolean },
  env: Env = process.env,
): StartTrialRefusal | null {
  if (club.approvedAt === null) return "not-self-join";
  if (!isBillingEnabled(env)) return "flag-off";
  if (club.billingStatus !== "exempt") return "not-exempt";
  if (club.hadFreeMonth) return "had-free-month";
  if (club.billingPlan === "free") return "plan-free";
  return null;
}

// ── The owner page's totals line (slice B2, 8.3 point 3) ────────────────

export interface BillingTotals {
  /** Billed clubs with a card on file. */
  withCard: number;
  /** The sum of each club's last closed month, where it was paid. */
  lastMonthChargedPence: number;
  /** The sum of each club's open month so far (what it would charge if
   *  it closed now). */
  thisMonthPence: number;
  /** Clubs with a club fee month failed or still being taken, and the total. */
  unpaidClubs: number;
  unpaidPence: number;
  /** Clubs flagged "Check VAT country". */
  vatCheck: number;
  trial: number;
  grace: number;
  pastDue: number;
  paused: number;
}

/** One live club's row for the totals (slice P4, games played). */
export interface BillingTotalsRow {
  status: string;
  cardOnFile: boolean;
  vatCheck: boolean;
  /** The open month so far, in pence (0 when nothing would be charged),
   *  or null when no month is open. */
  thisMonthPence: number | null;
  /** The club's last closed month. */
  lastMonth: { status: string; amountPence: number | null } | null;
  /** The total of its failed or still-being-taken months. */
  unpaidPence: number;
}

/**
 * The /admin/clubs totals line (8.3). Read from our tables; Stripe's
 * dashboard stays the money record. "Last month" is each club's own last
 * closed month (clubs' months start on different days), counted only when
 * it was paid.
 */
export function billingTotals(rows: BillingTotalsRow[]): BillingTotals {
  const totals: BillingTotals = {
    withCard: 0,
    lastMonthChargedPence: 0,
    thisMonthPence: 0,
    unpaidClubs: 0,
    unpaidPence: 0,
    vatCheck: 0,
    trial: 0,
    grace: 0,
    pastDue: 0,
    paused: 0,
  };
  for (const r of rows) {
    if (r.status === "exempt") continue;
    if (r.cardOnFile) totals.withCard++;
    if (r.vatCheck) totals.vatCheck++;
    totals.thisMonthPence += r.thisMonthPence ?? 0;
    if (r.lastMonth?.status === "paid") totals.lastMonthChargedPence += r.lastMonth.amountPence ?? 0;
    if (r.unpaidPence > 0) {
      totals.unpaidClubs++;
      totals.unpaidPence += r.unpaidPence;
    }
    if (r.status === "trial") totals.trial++;
    else if (r.status === "grace") totals.grace++;
    else if (r.status === "past_due") totals.pastDue++;
    else if (r.status === "paused") totals.paused++;
  }
  return totals;
}

/**
 * May this viewer open a month's Stripe receipt from the billing page
 * (slice P4)? A receipt is Stripe's hosted invoice page, which shows the
 * payer's name, email and billing address. So: only the billing contact,
 * only while the card on file is their own, only for a PAID month with an
 * invoice, and only for months whose invoice was made since that card went
 * on (`invoicedAt`, the month's close, against `cardSince`, the latest
 * applied card session; null when none is recorded). The invoice carries
 * the payer details of the moment it was made, so a month invoiced while an
 * earlier collector paid is listed without its receipt, even when the new
 * card paid it.
 */
export function receiptAllowed(p: {
  role: string;
  ownCard: boolean;
  status: string;
  hasInvoice: boolean;
  invoicedAt: Date | null;
  cardSince: Date | null;
}): boolean {
  if (p.role !== "contact" || !p.ownCard) return false;
  if (p.status !== "paid" || !p.hasInvoice || !p.invoicedAt) return false;
  return p.cardSince === null || p.invoicedAt.getTime() >= p.cardSince.getTime();
}

// ── Slice B3: Stripe (section 5.4) ─────────────────────────────────────
//
// Slice P2 retired the subscription helpers (`checkoutTrialEnd`, the 49
// hour rule, `isLiveSubscriptionStatus`, `isUnpaidSubscriptionStatus`,
// `subscriptionStateEvent`): a card is saved in setup mode and each month
// is one invoice our own month close creates (plan 5.1, option b).

/**
 * UK only at first (5.4, decision 11): the billing address country and the
 * card's issuing country are the two pieces of evidence of where the payer
 * lives. Either one not GB, or unknown, flags the club "Check VAT country"
 * on /admin/clubs. The card is kept either way: refusing after the
 * card is taken would be worse.
 */
export function vatCountryNeedsCheck(billingCountry: string | null | undefined, cardCountry: string | null | undefined): boolean {
  const gb = (c: string | null | undefined) => typeof c === "string" && c.trim().toUpperCase() === "GB";
  return !(gb(billingCountry) && gb(cardCountry));
}
