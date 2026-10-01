/**
 * CLUB FEE BILLING, slice B2: the words, from the numbers. PURE: no
 * database, no clock.
 * Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 7.2 and 8.
 *
 * club-billing-rules.ts decides (the tip's numbers, who may see what);
 * this file turns those decisions into the club's language through the
 * string tables (src/lib/i18n). The billing page, the settings card, the
 * banner and the "you're live" DM all read it, so each state is worded in
 * one place.
 *
 * The billing state is passed as `status` (not `billingStatus`): the
 * column has one writer and its name is guarded
 * (`__tests__/club-billing-source-guard.test.ts`).
 */
import { t } from "./i18n/t";
import { dayLabel } from "./i18n/dates";
import type { Lang } from "./i18n/lang";
import {
  GRACE_DAYS,
  STANDARD_PRICE_PENCE,
  isLiveSubscriptionStatus,
  isUnpaidSubscriptionStatus,
  planPricePence,
  type BillingAccessRole,
  type ClubFeeTip,
} from "./club-billing-rules";

type LangIn = Lang | string | null | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "£9.99", "£5", "£8.25": as `gbp()` in payments.ts writes match fees. */
export function moneyLabel(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

/** The share per player per game: "25p", or "£1.05" from GBP 1 up. */
export function shareLabel(pence: number): string {
  return pence < 100 ? `${pence}p` : `£${(pence / 100).toFixed(2)}`;
}

/** The club fee tip paragraph (7.2), in the club's language. */
export function clubFeeTipText(lang: LangIn, tip: ClubFeeTip): string {
  const s = t(lang);
  return s.club_fee_tip({
    format: s.sj_per_side_option({ perSide: tip.perSide }),
    players: tip.players,
    games: tip.games,
    price: moneyLabel(tip.pricePence),
    share: shareLabel(tip.sharePence),
    fee: moneyLabel(tip.feePence),
    feePlus: moneyLabel(tip.feePlusPence),
    mode: tip.split ? "split" : tip.feeSource === "example" ? "example" : "known",
  });
}

/** The short tip that follows "Your first month is free." in the
 *  "you're live" DM of a billed club. */
export function approvedTipText(lang: LangIn, tip: ClubFeeTip): string {
  return t(lang).sj_dm_approved_tip({
    players: tip.players,
    games: tip.games,
    price: moneyLabel(tip.pricePence),
    share: shareLabel(tip.sharePence),
    fee: moneyLabel(tip.feePence),
    feePlus: moneyLabel(tip.feePlusPence),
    split: tip.split,
  });
}

/** What the page, the card and the banner know about a billed club. */
export interface BillingStateInput {
  /** `Organisation.billingStatus`. */
  status: string;
  plan: string;
  pricePence: number | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  cardHolderUserId: string | null;
  cardHolderName: string | null;
  /** Who is looking. */
  viewerUserId: string;
  role: BillingAccessRole;
  /** Stripe's word for the club's subscription, or null (slice B3). */
  subscriptionStatus?: string | null;
  /** The dedicated Customer Portal configuration is set (review fix 4):
   *  without it there is no Portal button at all. */
  portalAvailable?: boolean;
  /** Why a paused club is paused (slice B5: "removed" asks for MatchTime
   *  to be added back to the group, not for a card). */
  pausedReason?: string | null;
}

function graceDate(v: { trialEndsAt: Date | null; graceEndsAt: Date | null }): Date | null {
  if (v.graceEndsAt) return v.graceEndsAt;
  return v.trialEndsAt ? new Date(v.trialEndsAt.getTime() + GRACE_DAYS * DAY_MS) : null;
}

function priceOf(v: { plan: string; pricePence: number | null }): string {
  return moneyLabel(planPricePence(v.plan, v.pricePence) ?? STANDARD_PRICE_PENCE);
}

/** Is the card on file the viewer's own? (No holder recorded counts as
 *  the contact's own: there is nobody else's card to point at.) */
function ownCard(v: BillingStateInput): boolean {
  return v.cardHolderUserId === null || v.cardHolderUserId === v.viewerUserId;
}

/**
 * The state lines of section 8.1's table. The card's brand and last four
 * are shown only to the person whose card it is.
 */
export function billingStateLines(lang: LangIn, v: BillingStateInput): string[] {
  const s = t(lang);
  const date = (d: Date | null) => (d ? dayLabel(lang, d) : "");
  const price = priceOf(v);
  const next = v.currentPeriodEnd ?? v.trialEndsAt;
  switch (v.status) {
    case "trial":
      return [s.billing_state_trial({ date: date(v.trialEndsAt), price })];
    case "grace":
      return [s.billing_state_grace({ date: date(graceDate(v)) })];
    case "past_due":
      return [s.billing_state_past_due({ date: date(graceDate(v)) })];
    case "paused":
      return [v.pausedReason === "removed" ? s.billing_state_paused_removed : s.billing_state_paused];
    case "subscribed": {
      if (v.cancelAtPeriodEnd) return [s.billing_state_subscribed_ending({ price, date: date(next) })];
      if (v.role === "contact" && !ownCard(v)) {
        return [s.billing_state_paid_with_other({ price, holder: v.cardHolderName ?? "", date: date(next) })];
      }
      const lines = [s.billing_state_subscribed({ price, date: date(next) })];
      const mine = v.cardHolderUserId !== null && v.cardHolderUserId === v.viewerUserId;
      if (mine && v.cardBrand && v.cardLast4) lines.push(s.billing_state_card({ brand: v.cardBrand, last4: v.cardLast4 }));
      return lines;
    }
    default:
      return [];
  }
}

export type BillingButton = "add-card" | "change-card" | "use-mine" | "update-card" | "remove-mine";

/**
 * The card buttons the page shows this viewer (8.1). Each one is a server
 * action that re-checks who the viewer is (slice B3).
 *
 *   add-card      no live subscription (trial, grace, paused)
 *   update-card   "Update card and pay": the subscription is UNPAID, in any
 *                 state; setup mode, then the open invoice is retried, so a
 *                 club that cannot pay is never a dead end (review fix 2)
 *   change-card   the Customer Portal: ONLY the contact whose own card is on
 *                 file, and only with the dedicated Portal configuration
 *                 (review fix 4)
 *   use-mine      setup mode: somebody else's card, no card on file, or no
 *                 Portal configured
 *   remove-mine   an old card holder
 */
export function billingButtons(v: BillingStateInput): BillingButton[] {
  if (v.role === "card-holder") return ["remove-mine"];
  if (v.role !== "contact") return [];
  const sub = v.subscriptionStatus ?? null;
  const known = ["trial", "grace", "paused", "subscribed", "past_due"];
  if (!known.includes(v.status)) return [];
  // Slice B5: the way back is adding MatchTime to the group again; a card
  // first would pay for a group MatchTime is not in (club-billing-stripe.ts
  // refuses it too).
  if (v.status === "paused" && v.pausedReason === "removed") return [];
  if (isUnpaidSubscriptionStatus(sub) || v.status === "past_due") return ["update-card"];
  const mineWithPortal = v.cardHolderUserId !== null && v.cardHolderUserId === v.viewerUserId && v.portalAvailable === true;
  if (v.status === "subscribed" || isLiveSubscriptionStatus(sub)) return [mineWithPortal ? "change-card" : "use-mine"];
  return ["add-card"];
}

/** The admin banner (8.2): grace, past due and paused only. */
export function bannerText(
  lang: LangIn,
  v: { status: string; trialEndsAt: Date | null; graceEndsAt: Date | null; pausedReason?: string | null },
): string | null {
  const s = t(lang);
  const d = graceDate(v);
  const date = d ? dayLabel(lang, d) : "";
  if (v.status === "grace") return s.billing_banner_grace({ date });
  if (v.status === "past_due") return s.billing_banner_past_due({ date });
  if (v.status === "paused") return v.pausedReason === "removed" ? s.billing_banner_paused_removed : s.billing_banner_paused;
  return null;
}

// ── The billing page and the settings card (8.1), as data ───────────────

/** What the page and the card know about the club (from
 *  `loadClubBillingSnapshot` in club-billing.ts). */
export interface BillingViewClub {
  club: string;
  status: string;
  plan: string;
  pricePence: number | null;
  paymentHolderId: string | null;
  contact: { userId: string; via: "collector" | "owner"; name: string | null } | null;
  billing: {
    trialEndsAt: Date;
    graceEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    cardBrand: string | null;
    cardLast4: string | null;
    cardHolderUserId: string | null;
    stripeSubscriptionStatus?: string | null;
    /** Slice B5. */
    pausedReason?: string | null;
  } | null;
  cardHolderName: string | null;
}

export interface BillingPageView {
  title: string;
  club: string;
  /** Exempt club, for its owner: this one line and nothing else. */
  exempt: string | null;
  lines: string[];
  /** "{name} looks after the card", for anybody but the contact. */
  who: string | null;
  /** The old card holder's line. */
  holderNote: string | null;
  buttons: Array<{ key: BillingButton; label: string }>;
  tip: string | null;
}

function stateInput(
  c: BillingViewClub,
  viewerUserId: string,
  role: BillingAccessRole,
  portalAvailable = false,
): BillingStateInput {
  return {
    subscriptionStatus: c.billing?.stripeSubscriptionStatus ?? null,
    portalAvailable,
    pausedReason: c.billing?.pausedReason ?? null,
    status: c.status,
    plan: c.plan,
    pricePence: c.pricePence,
    trialEndsAt: c.billing?.trialEndsAt ?? null,
    graceEndsAt: c.billing?.graceEndsAt ?? null,
    currentPeriodEnd: c.billing?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: c.billing?.cancelAtPeriodEnd ?? false,
    cardBrand: c.billing?.cardBrand ?? null,
    cardLast4: c.billing?.cardLast4 ?? null,
    cardHolderUserId: c.billing?.cardHolderUserId ?? null,
    cardHolderName: c.cardHolderName,
    viewerUserId,
    role,
  };
}

/** Who pays, in a line: the collector, the owner fallback, or nobody. */
export function whoPaysLine(lang: LangIn, c: Pick<BillingViewClub, "contact">): string {
  const s = t(lang);
  if (!c.contact) return s.billing_who_none;
  if (c.contact.via === "owner") return s.billing_who_owner;
  return s.billing_who_collector({ name: c.contact.name ?? "" });
}

const BUTTON_LABEL: Record<BillingButton, (s: ReturnType<typeof t>) => string> = {
  "add-card": (s) => s.billing_btn_add_card,
  "change-card": (s) => s.billing_btn_change_card,
  "use-mine": (s) => s.billing_btn_use_mine,
  "update-card": (s) => s.billing_btn_update_card,
  "remove-mine": (s) => s.billing_btn_remove_mine,
};

/**
 * /billing/[orgId] for one viewer (8.1). The contact sees the state, the
 * tip and their card buttons; an old card holder their note and Remove
 * my card; an OWNER or ADMIN (or the superadmin) the state, who pays and
 * the tip, no buttons; the owner of an exempt club one "exempt" line.
 */
export function billingPageView(
  lang: LangIn,
  c: BillingViewClub,
  role: BillingAccessRole,
  viewerUserId: string,
  tip: ClubFeeTip | null,
  opts: { portalAvailable?: boolean } = {},
): BillingPageView {
  const s = t(lang);
  const base = { title: s.billing_page_title, club: c.club };
  if (role === "exempt-owner") {
    return { ...base, exempt: s.billing_exempt({ club: c.club }), lines: [], who: null, holderNote: null, buttons: [], tip: null };
  }
  const v = stateInput(c, viewerUserId, role, opts.portalAvailable ?? false);
  const buttons = billingButtons(v).map((key) => ({ key, label: BUTTON_LABEL[key](s) }));
  return {
    ...base,
    exempt: null,
    lines: role === "card-holder" ? [] : billingStateLines(lang, v),
    who: role === "viewer" ? whoPaysLine(lang, c) : null,
    holderNote:
      role === "card-holder" ? s.billing_card_holder_note({ club: c.club, contact: c.contact?.name ?? "" }) : null,
    buttons,
    tip: tip && role !== "card-holder" ? clubFeeTipText(lang, tip) : null,
  };
}

export interface BillingCardView {
  title: string;
  lines: string[];
  who: string;
  cardOnFile: string;
  tip: string | null;
  openLabel: string;
  /** Set when no money collector is chosen. */
  chooseCollectorLabel: string | null;
}

/**
 * The /admin/settings billing card (8.1), the same for every OWNER and
 * ADMIN: the state (never the card's brand or last four), who pays, card
 * on file yes or no, the tip, and the link to the billing page. Null for
 * an exempt club: Sutton FC sees nothing new.
 */
export function billingCardView(lang: LangIn, c: BillingViewClub, tip: ClubFeeTip | null): BillingCardView | null {
  if (c.status === "exempt") return null;
  const s = t(lang);
  return {
    title: s.billing_page_title,
    lines: billingStateLines(lang, stateInput(c, "", "viewer")),
    who: whoPaysLine(lang, c),
    cardOnFile: s.billing_card_on_file({ yes: !!c.billing?.cardHolderUserId || !!c.billing?.cardLast4 }),
    tip: tip ? clubFeeTipText(lang, tip) : null,
    openLabel: s.billing_open,
    chooseCollectorLabel: c.contact?.via === "collector" ? null : s.billing_choose_collector,
  };
}

// ── Slice B3: the webhook's DMs and the page's notices ──────────────────

/** "Card added" (7.3), to whoever added the card. `firstPaymentOn` null
 *  means the first payment was taken at once (grace, or after a pause). */
export function cardAddedText(
  lang: LangIn,
  p: { name: string | null; club: string; pricePence: number; firstPaymentOn: Date | null; resumed: boolean; link: string },
): string {
  return t(lang).billing_dm_card_added({
    name: p.name,
    club: p.club,
    price: moneyLabel(p.pricePence),
    date: p.firstPaymentOn ? dayLabel(lang, p.firstPaymentOn) : "",
    paidNow: p.firstPaymentOn === null,
    resumed: p.resumed,
    link: p.link,
  });
}

/** "Card replaced" (7.3), to the old card holder. No link. */
export function cardReplacedText(lang: LangIn, p: { name: string | null; newName: string; club: string }): string {
  return t(lang).billing_dm_card_replaced(p);
}

/** "Resumed" (7.3), to the billing contact, after a recovered payment. */
export function resumedText(lang: LangIn, p: { club: string }): string {
  return t(lang).billing_dm_resumed(p);
}

/** Billed again after Free with the free month used up: a fresh grace
 *  week, and a card asked for. */
export function planBilledText(
  lang: LangIn,
  p: { name: string | null; club: string; pricePence: number; graceEndsAt: Date; link: string },
): string {
  return t(lang).billing_dm_plan_billed({
    name: p.name,
    club: p.club,
    price: moneyLabel(p.pricePence),
    date: dayLabel(lang, p.graceEndsAt),
    link: p.link,
  });
}

export type BillingPageNotice = "done" | "replaced" | "removed" | "not-set-up" | "already" | "re-add" | "failed";

/** The line the billing page shows after a card action. */
export function billingNoticeText(lang: LangIn, n: BillingPageNotice): string {
  const s = t(lang);
  switch (n) {
    case "done":
      return s.billing_notice_done;
    case "replaced":
      return s.billing_notice_replaced;
    case "removed":
      return s.billing_notice_removed;
    case "not-set-up":
      return s.billing_notice_not_set_up;
    case "already":
      return s.billing_notice_already;
    case "re-add":
      return s.billing_notice_re_add;
    case "failed":
      return s.billing_notice_failed;
  }
}

// ── Slice B4: the scheduler's DMs and the admin channel's tip (7.2, 7.3) ─

/** "set a money collector" is added only when the owner is asked because
 *  no collector is set (`billingContact(...).via === "owner"`). */
type ContactVia = "collector" | "owner";

function withExtras(lang: LangIn, body: string, extras: { tip?: ClubFeeTip | null; via?: ContactVia }): string {
  const parts = [body];
  if (extras.tip) parts.push(clubFeeTipText(lang, extras.tip));
  if (extras.via === "owner") parts.push(t(lang).billing_dm_set_collector);
  return parts.join("\n\n");
}

/** Day 21 and day 28 (7.3). `tip` is passed when the DM carries the club
 *  fee tip (day 21, or day 28 when day 21 never reached the contact). */
export function trialReminderText(
  lang: LangIn,
  p: {
    kind: "trial-21" | "trial-28";
    name: string | null;
    club: string;
    trialEndsAt: Date;
    pricePence: number;
    link: string;
    via: ContactVia;
    tip: ClubFeeTip | null;
  },
): string {
  const s = t(lang);
  const date = dayLabel(lang, p.trialEndsAt);
  const body =
    p.kind === "trial-21"
      ? s.billing_dm_trial_21({ name: p.name, club: p.club, date, price: moneyLabel(p.pricePence), link: p.link, collector: p.via === "collector" })
      : s.billing_dm_trial_28({ name: p.name, club: p.club, date, link: p.link });
  return withExtras(lang, body, { tip: p.tip, via: p.via });
}

/** Day 30: the free month has ended, a week's grace (7.3). */
export function trialEndedText(
  lang: LangIn,
  p: { name: string | null; club: string; graceEndsAt: Date; link: string; via: ContactVia },
): string {
  const body = t(lang).billing_dm_trial_ended({ name: p.name, club: p.club, date: dayLabel(lang, p.graceEndsAt), link: p.link });
  return withExtras(lang, body, { via: p.via });
}

/** Paused: no card after the grace week, a payment not recovered, or a
 *  plan that ended after a cancel (7.3). */
export function pausedText(
  lang: LangIn,
  p: { name: string | null; club: string; pricePence: number; reason: "no-card" | "payment-failed" | "cancelled"; link: string },
): string {
  return t(lang).billing_dm_paused({ name: p.name, club: p.club, price: moneyLabel(p.pricePence), link: p.link, kind: p.reason });
}

/** This month's payment did not go through (7.3). `ownCard` false: the
 *  failing card is somebody else's (a collector change in progress). */
export function paymentFailedText(
  lang: LangIn,
  p: { name: string | null; club: string; pricePence: number; link: string; ownCard: boolean },
): string {
  return t(lang).billing_dm_payment_failed({ name: p.name, club: p.club, price: moneyLabel(p.pricePence), link: p.link, ownCard: p.ownCard });
}

/** The bank wants the payer to confirm the payment (3DS). `link` is the
 *  invoice's own Stripe page, where the check is done; `billingLink` the
 *  recipient's billing page, offered when the card is not their own. */
export function paymentActionText(
  lang: LangIn,
  p: { name: string | null; club: string; pricePence: number; link: string; ownCard: boolean; billingLink: string },
): string {
  const base = { name: p.name, club: p.club, price: moneyLabel(p.pricePence), link: p.link };
  // Someone else's card (a collector change in progress): the recipient
  // may confirm that payment, or put their own card on instead.
  return p.ownCard
    ? t(lang).billing_dm_payment_action(base)
    : t(lang).billing_dm_payment_action_other({ ...base, billingLink: p.billingLink });
}

/** To a new money collector, once (4.5 point 2), then the tip. */
export function payerChangedText(
  lang: LangIn,
  p: {
    name: string | null;
    club: string;
    pricePence: number;
    link: string;
    /** "card": somebody else's card is paying; "no-card": add one before
     *  `date`; "paused": add one to switch MatchTime back on; "removed":
     *  paused because MatchTime was taken out of the group, so it must be
     *  added back (slice B5). */
    state: "card" | "no-card" | "paused" | "removed";
    oldName: string | null;
    date: Date | null;
    tip: ClubFeeTip | null;
  },
): string {
  const s = t(lang);
  const base = { name: p.name, club: p.club, price: moneyLabel(p.pricePence), link: p.link };
  const body =
    p.state === "card"
      ? s.billing_dm_payer_changed_card({ ...base, oldName: p.oldName ?? "" })
      : p.state === "no-card" && p.date
        ? s.billing_dm_payer_changed_no_card({ ...base, date: dayLabel(lang, p.date) })
        : p.state === "removed"
          ? s.billing_dm_payer_changed_removed(base)
          : s.billing_dm_payer_changed_paused(base);
  return withExtras(lang, body, { tip: p.tip });
}

/** The admin channel's club fee tip (7.2 point 3). With no collector set,
 *  one more line asking the admins to choose one (the reader's own
 *  signed-in link by DM, the plain URL in the admin group). */
export function feeTipAdminText(lang: LangIn, tip: ClubFeeTip, p: { noCollector: boolean; link: string }): string {
  const parts = [clubFeeTipText(lang, tip)];
  if (p.noCollector) parts.push(t(lang).billing_admin_no_collector({ link: p.link }));
  return parts.join("\n\n");
}
