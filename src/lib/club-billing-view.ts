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
import { dayLabel, dayMonthShortLabel } from "./i18n/dates";
import { monthBounds, monthFee } from "./club-billing-cycle-rules";
import { BILLING_DM_FROM_HOUR } from "./club-billing-schedule-rules";
import type { Lang } from "./i18n/lang";
import type { MonthsSummary } from "./club-billing-month-summary";
import {
  GRACE_DAYS,
  STANDARD_PRICE_PENCE,
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
    players: tip.players,
    price: moneyLabel(tip.pricePence),
    perGame: moneyLabel(tip.perGamePence),
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
    price: moneyLabel(tip.pricePence),
    perGame: moneyLabel(tip.perGamePence),
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
  /** Why a paused club is paused (slice B5: "removed" asks for MatchTime
   *  to be added back to the group, not for a card). */
  pausedReason?: string | null;
  /** Slice P4: the moment the page is drawn (pure: never read from the
   *  clock here). Inside the free month a saved card reads "Nothing is
   *  taken until ...". Without it the free month is never assumed. */
  now?: Date | null;
  /** Slice P4: what is unpaid (failed or still being taken months): their
   *  total, how many, and the latest one's dates. */
  unpaid?: UnpaidSummary | null;
  /** Slice P4: retries are switched on (`billingRetriesOn`). Default on. */
  retrying?: boolean;
}

/** The club's unpaid club fee months, as the page and the banner name them. */
export interface UnpaidSummary {
  totalPence: number;
  count: number;
  /** The latest unpaid month. */
  startsAt: Date;
  endsAt: Date;
}

function unpaidParams(lang: LangIn, u: UnpaidSummary | null | undefined): { amount: string; from: string; to: string; months: number } {
  if (!u || u.count < 1 || u.totalPence <= 0) return { amount: "", from: "", to: "", months: 0 };
  return { amount: moneyLabel(u.totalPence), ...monthRangeLabels(lang, u), months: u.count };
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
  // The first charge after the free month: the morning after month 1 ends
  // (plan 2A.1). Later on, the end of the current month (`currentPeriodEnd`
  // mirrors it, P2).
  const firstCharge = v.trialEndsAt ? monthBounds(v.trialEndsAt, 1).endsAt : null;
  const next = v.currentPeriodEnd ?? firstCharge;
  const retrying = v.retrying ?? true;
  switch (v.status) {
    case "trial":
      return [s.billing_state_trial({ date: date(v.trialEndsAt), price })];
    case "grace":
      return [s.billing_state_grace({ date: date(graceDate(v)) })];
    case "past_due":
      return [s.billing_state_past_due({ ...unpaidParams(lang, v.unpaid), retrying, date: date(graceDate(v)) })];
    case "paused":
      if (v.pausedReason === "removed") return [s.billing_state_paused_removed];
      if (v.pausedReason === "payment-failed") {
        const u = unpaidParams(lang, v.unpaid);
        return [s.billing_state_paused_unpaid({ amount: u.amount, months: u.months })];
      }
      if (v.pausedReason === "cancelled") return [s.billing_state_paused_stopped];
      return [s.billing_state_paused];
    case "subscribed": {
      if (v.cancelAtPeriodEnd) return [s.billing_state_subscribed_ending({ date: date(next) })];
      const inFreeMonth = !!(v.now && v.trialEndsAt && v.now.getTime() < v.trialEndsAt.getTime());
      const main = inFreeMonth ? s.billing_state_card_saved({ date: date(firstCharge) }) : s.billing_state_subscribed({ price, date: date(next) });
      if (v.role === "contact" && !ownCard(v)) {
        const rest = inFreeMonth ? s.billing_state_nothing_until({ date: date(firstCharge) }) : main;
        return [s.billing_state_paid_with_other({ holder: v.cardHolderName ?? "", rest })];
      }
      const lines = [main];
      const mine = v.cardHolderUserId !== null && v.cardHolderUserId === v.viewerUserId;
      if (mine && v.cardBrand && v.cardLast4) lines.push(s.billing_state_card({ brand: v.cardBrand, last4: v.cardLast4 }));
      return lines;
    }
    default:
      return [];
  }
}

// ── Slice P4: the month box, past months, and the owner's columns ──────

/** The fee for `played` of `scheduled` at `pricePence`, as words: the
 *  amount, or "nothing" when no charge would be made (none played, none
 *  scheduled, or under Stripe's 30p minimum). */
function feeWords(lang: LangIn, pricePence: number, played: number, scheduled: number): string {
  const f = monthFee({ priceAtStartPence: pricePence, played, scheduled });
  return f.charge ? moneyLabel(f.amountPence) : t(lang).billing_nothing;
}

/** This month so far, as the billing page and the settings card show it
 *  (plan 8.1). `pricePence` is the month's maximum (the lower of the price
 *  when it opened and now). Charged on the morning after it ends. */
export function monthBoxText(
  lang: LangIn,
  m: { startsAt: Date; endsAt: Date; played: number; scheduled: number; upcoming: number; pricePence: number },
): string {
  return t(lang).billing_month_box({
    ...monthRangeLabels(lang, m),
    played: m.played,
    scheduled: m.scheduled,
    upcoming: m.upcoming,
    amount: feeWords(lang, m.pricePence, m.played, m.scheduled),
    max: feeWords(lang, m.pricePence, Math.min(m.scheduled, m.played + m.upcoming), m.scheduled),
    date: dayLabel(lang, m.endsAt),
  });
}

/** One closed month on the billing page: "1 Nov to 30 Nov: 4 of 5 games,
 *  £7.99 paid", "no games, nothing to pay" (plan 8.1). */
export function pastMonthLine(
  lang: LangIn,
  m: { startsAt: Date; endsAt: Date; status: string; played: number | null; scheduled: number | null; amountPence: number | null },
): string {
  const s = t(lang);
  const counted = m.played !== null && m.scheduled !== null && m.scheduled > 0 && m.status !== "waived";
  return s.billing_month_line({
    ...monthRangeLabels(lang, m),
    status: m.status,
    games: counted ? s.billing_month_games({ played: m.played!, scheduled: m.scheduled! }) : "",
    amount: m.amountPence !== null ? moneyLabel(m.amountPence) : "",
  });
}

/** One game of a month, behind "See games": its day and why it was or was
 *  not played (never who played). */
export function gameLine(lang: LangIn, g: { kickoff: Date; outcome: string }): string {
  return `${dayLabel(lang, g.kickoff)}: ${t(lang).billing_game_outcome({ outcome: g.outcome })}`;
}

/**
 * /admin/clubs (English): when a month's charge runs. A month ends at 00:00
 * London (`endsAt`, exclusive) and its close charges it that same London day
 * from 10:00 (daytime runs only), so the label is that day and "from 10:00",
 * never the bare 00:00 instant (test mode, 2026-10-05).
 */
export function ownerChargeDateLabel(endsAt: Date): string {
  return `${dayLabel("en", endsAt)}, from ${String(BILLING_DM_FROM_HOUR).padStart(2, "0")}:00`;
}

/** /admin/clubs (English, the platform owner's page): this month so far. */
export function ownerThisMonthLabel(m: { played: number; scheduled: number; amountPence: number } | null): string {
  if (!m) return "no month open";
  return `${m.played} of ${m.scheduled} so far, ${m.amountPence > 0 ? moneyLabel(m.amountPence) : "nothing yet"}`;
}

/** /admin/clubs: the club's last closed month. */
export function ownerLastMonthLabel(m: { status: string; amountPence: number | null } | null): string {
  if (!m) return "none yet";
  const amount = m.amountPence !== null ? moneyLabel(m.amountPence) : "";
  switch (m.status) {
    case "paid":
      return `${amount} paid`;
    case "failed":
      return `${amount} failed`;
    case "invoiced":
      return `${amount} being taken`;
    case "void":
      return `${amount} voided`;
    case "no-games":
      return "no games";
    case "below-minimum":
      return "under 30p, not charged";
    case "no-card":
      return "not charged, no card";
    case "waived":
      return "waived";
    default:
      return "closing";
  }
}

export type BillingButton =
  | "add-card"
  | "change-card"
  | "use-mine"
  | "update-card"
  | "remove-mine"
  | "stop-paying"
  | "keep-paying";

/** A card is on file (its holder or its last four is known). */
function cardOnFile(v: BillingStateInput): boolean {
  return v.cardHolderUserId !== null || v.cardLast4 !== null;
}

/**
 * The card buttons the page shows this viewer (8.1). Each one is a server
 * action that re-checks who the viewer is. Slice P2: no Customer Portal;
 * every card change is Checkout in setup mode, and stopping is our own
 * button.
 *
 *   add-card      no card on file (trial, grace, paused for no card)
 *   update-card   "Update card and pay": a payment failed (past due, or
 *                 paused for it); setup mode, then what is unpaid is paid
 *                 on the new card, so a club that cannot pay is never a
 *                 dead end
 *   change-card   the contact's own card is on file: put another one on
 *   use-mine      somebody else's card is on file (a collector change)
 *   stop-paying   a card is on file and billing runs: it ends with the
 *                 current month (inside the free month the card goes)
 *   keep-paying   Stop paying was pressed (undo), or the club is paused
 *                 after it and its card is still on file (start again)
 *   remove-mine   an old card holder
 */
export function billingButtons(v: BillingStateInput): BillingButton[] {
  if (v.role === "card-holder") return ["remove-mine"];
  if (v.role !== "contact") return [];
  const known = ["trial", "grace", "paused", "subscribed", "past_due"];
  if (!known.includes(v.status)) return [];
  // Slice B5: the way back is adding MatchTime to the group again; a card
  // first would pay for a group MatchTime is not in (club-billing-stripe.ts
  // refuses it too).
  if (v.status === "paused" && v.pausedReason === "removed") return [];
  if (v.status === "past_due" || (v.status === "paused" && v.pausedReason === "payment-failed")) return ["update-card"];
  if (!cardOnFile(v)) return ["add-card"];
  if (v.status === "paused" && v.pausedReason === "cancelled") return ["keep-paying"];
  const card: BillingButton = ownCard(v) ? "change-card" : "use-mine";
  if (v.status === "subscribed") return [card, v.cancelAtPeriodEnd ? "keep-paying" : "stop-paying"];
  return [card];
}

/** The admin banner (8.2): grace, past due and paused only. */
export function bannerText(
  lang: LangIn,
  v: { status: string; trialEndsAt: Date | null; graceEndsAt: Date | null; pausedReason?: string | null; unpaid?: UnpaidSummary | null },
): string | null {
  const s = t(lang);
  const d = graceDate(v);
  const date = d ? dayLabel(lang, d) : "";
  if (v.status === "grace") return s.billing_banner_grace({ date });
  if (v.status === "past_due") return s.billing_banner_past_due({ ...unpaidParams(lang, v.unpaid), date });
  if (v.status === "paused") {
    if (v.pausedReason === "removed") return s.billing_banner_paused_removed;
    if (v.pausedReason === "payment-failed") return s.billing_banner_paused_unpaid;
    if (v.pausedReason === "cancelled") return s.billing_banner_paused_stopped;
    return s.billing_banner_paused;
  }
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
  /** Slice P4: this month so far (8.1), or null. */
  monthBox: string | null;
  /** Slice P4: the closed months, newest first. */
  pastTitle: string;
  past: PastMonthView[];
  seeGamesLabel: string;
  receiptLabel: string;
  /**
   * Stop paying asks first (test mode fix, 2026-10-05): the button opens
   * this confirmation (what stopping means, and the date), and only "yes"
   * posts the action. Null when there is no Stop paying button.
   */
  stopConfirm: { title: string; text: string; yes: string; no: string } | null;
}

/** One closed month on the page: its line, its games, and (for the payer,
 *  their own card's months only) the receipt link. */
export interface PastMonthView {
  id: string;
  line: string;
  games: string[];
  receiptHref: string | null;
}

/** The months part of the page or the card, in words. */
function monthsView(lang: LangIn, orgId: string, m: MonthsSummary | null | undefined): { monthBox: string | null; past: PastMonthView[] } {
  if (!m) return { monthBox: null, past: [] };
  return {
    monthBox: m.current ? monthBoxText(lang, m.current) : null,
    past: m.past.map((pm) => ({
      id: pm.id,
      line: pastMonthLine(lang, pm),
      games: pm.games.map((g) => gameLine(lang, g)),
      receiptHref: pm.receipt ? `/billing/${orgId}/receipt/${pm.id}` : null,
    })),
  };
}

function stateInput(
  c: BillingViewClub,
  viewerUserId: string,
  role: BillingAccessRole,
  extra: { now?: Date | null; months?: MonthsSummary | null } = {},
): BillingStateInput {
  return {
    now: extra.now ?? null,
    unpaid: extra.months?.unpaid ?? null,
    retrying: extra.months?.retrying ?? true,
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
  "stop-paying": (s) => s.billing_btn_stop_paying,
  "keep-paying": (s) => s.billing_btn_keep_paying,
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
  extra: { now?: Date | null; months?: MonthsSummary | null; orgId?: string } = {},
): BillingPageView {
  const s = t(lang);
  const base = {
    title: s.billing_page_title,
    club: c.club,
    pastTitle: s.billing_past_months,
    seeGamesLabel: s.billing_see_games,
    receiptLabel: s.billing_receipt,
  };
  if (role === "exempt-owner") {
    return {
      ...base,
      exempt: s.billing_exempt({ club: c.club }),
      lines: [],
      who: null,
      holderNote: null,
      buttons: [],
      tip: null,
      monthBox: null,
      past: [],
      stopConfirm: null,
    };
  }
  const v = stateInput(c, viewerUserId, role, extra);
  const buttons = billingButtons(v).map((key) => ({ key, label: BUTTON_LABEL[key](s) }));
  // An old card holder sees only their own note and button.
  const months = role === "card-holder" ? { monthBox: null, past: [] } : monthsView(lang, extra.orgId ?? "", extra.months);
  return {
    ...base,
    ...months,
    exempt: null,
    lines: role === "card-holder" ? [] : billingStateLines(lang, v),
    who: role === "viewer" ? whoPaysLine(lang, c) : null,
    holderNote:
      role === "card-holder" ? s.billing_card_holder_note({ club: c.club, contact: c.contact?.name ?? "" }) : null,
    buttons,
    tip: tip && role !== "card-holder" ? clubFeeTipText(lang, tip) : null,
    stopConfirm: buttons.some((b) => b.key === "stop-paying") ? stopConfirmView(lang, v) : null,
  };
}

/** What the Stop paying confirmation says: inside the free month the card
 *  goes at once (`stopPaying`); otherwise billing ends with the current
 *  month, on the day it is charged. */
function stopConfirmView(lang: LangIn, v: BillingStateInput): NonNullable<BillingPageView["stopConfirm"]> {
  const s = t(lang);
  const inFreeMonth = !!(v.now && v.trialEndsAt && v.now.getTime() < v.trialEndsAt.getTime());
  const next = v.currentPeriodEnd ?? (v.trialEndsAt ? monthBounds(v.trialEndsAt, 1).endsAt : null);
  const text = inFreeMonth
    ? s.billing_stop_confirm_free({ date: v.trialEndsAt ? dayLabel(lang, v.trialEndsAt) : "" })
    : s.billing_stop_confirm_month({ date: next ? dayLabel(lang, next) : "" });
  return { title: s.billing_stop_confirm_title, text, yes: s.billing_btn_stop_confirm_yes, no: s.billing_btn_stop_confirm_no };
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
  /** Slice P4: this month so far, and the last closed month. */
  month: string | null;
  lastMonth: string | null;
}

/**
 * The /admin/settings billing card (8.1), the same for every OWNER and
 * ADMIN: the state (never the card's brand or last four), who pays, card
 * on file yes or no, the tip, and the link to the billing page. Null for
 * an exempt club: Sutton FC sees nothing new.
 */
export function billingCardView(
  lang: LangIn,
  c: BillingViewClub,
  tip: ClubFeeTip | null,
  extra: { now?: Date | null; months?: MonthsSummary | null } = {},
): BillingCardView | null {
  if (c.status === "exempt") return null;
  const s = t(lang);
  const months = monthsView(lang, "", extra.months);
  return {
    title: s.billing_page_title,
    lines: billingStateLines(lang, stateInput(c, "", "viewer", extra)),
    month: months.monthBox,
    lastMonth: months.past[0]?.line ?? null,
    who: whoPaysLine(lang, c),
    cardOnFile: s.billing_card_on_file({ yes: !!c.billing?.cardHolderUserId || !!c.billing?.cardLast4 }),
    tip: tip ? clubFeeTipText(lang, tip) : null,
    openLabel: s.billing_open,
    chooseCollectorLabel: c.contact?.via === "collector" ? null : s.billing_choose_collector,
  };
}

// ── Slice B3: the webhook's DMs and the page's notices ──────────────────

/** "Card added" (7.3), to whoever added the card. Slice P3 (games
 *  played): nothing is taken when a card is saved; `firstChargeOn` is the
 *  morning after the current billing month ends, and `first` says whether
 *  any month has been charged before ("The first" or "The next"). */
export function cardAddedText(
  lang: LangIn,
  p: { name: string | null; club: string; pricePence: number; firstChargeOn: Date; first: boolean; resumed: boolean; link: string },
): string {
  return t(lang).billing_dm_card_added({
    name: p.name,
    club: p.club,
    price: moneyLabel(p.pricePence),
    date: dayLabel(lang, p.firstChargeOn),
    first: p.first,
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

export type BillingPageNotice =
  | "done"
  | "replaced"
  | "removed"
  | "not-set-up"
  | "already"
  | "re-add"
  | "failed"
  /** Slice P2: Stop paying, Keep paying, and a stop refused while a payment is overdue. */
  | "stopped"
  | "stopped-free"
  | "kept"
  | "past-due";

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
    case "stopped":
      return s.billing_notice_stopped;
    case "stopped-free":
      return s.billing_notice_stopped_free;
    case "kept":
      return s.billing_notice_kept;
    case "past-due":
      return s.billing_notice_past_due;
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
  const price = moneyLabel(p.pricePence);
  // The first charge: the morning after month 1 (the first month after the
  // free one) ends, which is when it closes (plan 2A.1).
  const firstCharge = dayLabel(lang, monthBounds(p.trialEndsAt, 1).endsAt);
  const body =
    p.kind === "trial-21"
      ? s.billing_dm_trial_21({ name: p.name, club: p.club, date, price, firstCharge, link: p.link, collector: p.via === "collector" })
      : s.billing_dm_trial_28({ name: p.name, club: p.club, date, price, link: p.link });
  return withExtras(lang, body, { tip: p.tip, via: p.via });
}

/** Day 30: the free month has ended, a week's grace (7.3). */
export function trialEndedText(
  lang: LangIn,
  p: { name: string | null; club: string; graceEndsAt: Date; pricePence: number; link: string; via: ContactVia },
): string {
  const body = t(lang).billing_dm_trial_ended({
    name: p.name,
    club: p.club,
    date: dayLabel(lang, p.graceEndsAt),
    price: moneyLabel(p.pricePence),
    link: p.link,
  });
  return withExtras(lang, body, { via: p.via });
}

/** Paused: no card after the grace week, a payment not recovered, or
 *  billing stopped by the payer (7.3). `amountPence`: what could not be
 *  taken (the unpaid month's charge); read only for "payment-failed". */
export function pausedText(
  lang: LangIn,
  p: {
    name: string | null;
    club: string;
    /** The TOTAL unpaid across `unpaidMonths` months (slice P4). */
    amountPence: number;
    unpaidMonths?: number;
    reason: "no-card" | "payment-failed" | "cancelled";
    link: string;
  },
): string {
  return t(lang).billing_dm_paused({
    name: p.name,
    club: p.club,
    amount: moneyLabel(p.amountPence),
    months: p.unpaidMonths ?? 1,
    link: p.link,
    kind: p.reason,
  });
}

/** A billing month's first and last day, as a DM names them: "1 Nov" and
 *  "30 Nov" ("1 Kasım", "30 Kasım"). `endsAt` is exclusive (00:00 London
 *  on the day the next month starts), so the last day is the day before. */
export function monthRangeLabels(lang: LangIn, m: { startsAt: Date; endsAt: Date }): { from: string; to: string } {
  return {
    from: dayMonthShortLabel(lang, m.startsAt),
    to: dayMonthShortLabel(lang, new Date(m.endsAt.getTime() - DAY_MS / 2)),
  };
}

/** A month's charge did not go through (7.3). `ownCard` false: the
 *  failing card is somebody else's (a collector change in progress). */
export function paymentFailedText(
  lang: LangIn,
  p: {
    name: string | null;
    club: string;
    amountPence: number;
    startsAt: Date;
    endsAt: Date;
    link: string;
    ownCard: boolean;
    /** Retries are on (`billingRetriesOn`): "It will be tried again".
     *  Off: nothing tries again, so the DM says how to pay now. */
    retrying: boolean;
  },
): string {
  return t(lang).billing_dm_payment_failed({
    name: p.name,
    club: p.club,
    amount: moneyLabel(p.amountPence),
    ...monthRangeLabels(lang, p),
    link: p.link,
    ownCard: p.ownCard,
    retrying: p.retrying,
  });
}

/** The bank wants the payer to confirm a month's charge (3DS). `link` is
 *  the invoice's own Stripe page, where the check is done; `billingLink`
 *  the recipient's billing page, offered when the card is not their own. */
export function paymentActionText(
  lang: LangIn,
  p: { name: string | null; club: string; amountPence: number; startsAt: Date; endsAt: Date; link: string; ownCard: boolean; billingLink: string },
): string {
  const base = { name: p.name, club: p.club, amount: moneyLabel(p.amountPence), ...monthRangeLabels(lang, p), link: p.link };
  // Someone else's card (a collector change in progress): the recipient
  // may confirm that payment, or put their own card on instead.
  return p.ownCard
    ? t(lang).billing_dm_payment_action(base)
    : t(lang).billing_dm_payment_action_other({ ...base, billingLink: p.billingLink });
}

// ── Slice P3: the month's receipt, a month with no games, Keep paying ───

/** The receipt, once a month's invoice is PAID (7.3): the games count,
 *  the charge, the card, the full month price. */
export function monthChargedText(
  lang: LangIn,
  p: {
    name: string | null;
    club: string;
    startsAt: Date;
    endsAt: Date;
    played: number;
    scheduled: number;
    amountPence: number;
    pricePence: number;
    last4: string | null;
    ownCard: boolean;
    link: string;
  },
): string {
  return t(lang).billing_dm_month_charged({
    name: p.name,
    club: p.club,
    played: p.played,
    scheduled: p.scheduled,
    ...monthRangeLabels(lang, p),
    amount: moneyLabel(p.amountPence),
    price: moneyLabel(p.pricePence),
    last4: p.last4,
    ownCard: p.ownCard,
    link: p.link,
  });
}

/** The FIRST month in a row with no games (7.3): nothing to pay. */
export function monthFreeText(lang: LangIn, p: { name: string | null; club: string; startsAt: Date; endsAt: Date }): string {
  return t(lang).billing_dm_month_free({ name: p.name, club: p.club, ...monthRangeLabels(lang, p) });
}

/** Keep paying: Stop paying undone, or (`restarted`) billing started again
 *  after the stop took effect. `nextChargeOn`: the morning after the
 *  current month ends. */
export function keepPayingText(
  lang: LangIn,
  p: { name: string | null; club: string; pricePence: number; nextChargeOn: Date; restarted: boolean; link: string },
): string {
  return t(lang).billing_dm_keep_paying({
    name: p.name,
    club: p.club,
    price: moneyLabel(p.pricePence),
    date: dayLabel(lang, p.nextChargeOn),
    restarted: p.restarted,
    link: p.link,
  });
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
