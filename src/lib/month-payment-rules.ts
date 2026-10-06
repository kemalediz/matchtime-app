/**
 * Monthly squad, slice 4: the month's price, payments and reminders. The
 * pure rules (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 4.2 and 4.3, and
 * decisions D1 (the organiser sets the share), D3 ("says paid" is a claim;
 * only the collector confirms) and D5 (bank transfer only).
 *
 *   PRICE     `suggestSharePence`, `defaultPayBy`, `validatePricing`,
 *             `planPricing` (share x games, minus credits, oldest first,
 *             never below zero), `priceLocked`, `monthFeeShare`.
 *   CLAIMS    `readPaidMessage`: the fixed words of a player's "paid".
 *   CONFIRM   `readCollectorReply` and `decideCollectorReply`: the
 *             collector's explicit "PAID ALL" / "PAID 1 3" / "PAID NONE".
 *             Never a stray "ok", never a bare number.
 *   REMINDERS `duePaymentReminder`, `groupReminderDue`, `claimsDigestDue`.
 *
 * Nothing here reads a database, calls a model or moves money. MatchTime
 * never sees the money: "confirmed" means the collector said so.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { isDaytime } from "./month-signup-rules";
import { foldListText } from "./monthly-list";
import { MAX_PER_GAME_PENCE } from "./squad-month-rules";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "2026-10-30": the London calendar day of a moment. */
const londonDay = (d: Date): string => formatLondon(d, "yyyy-MM-dd");

/** A London calendar day `n` days after (or before) another. */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole London calendar days from `from` to `to`. */
function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T12:00:00.000Z`).getTime() - new Date(`${from}T12:00:00.000Z`).getTime()) / DAY_MS);
}

// ── The price (plan 4.2) ───────────────────────────────────────────────

/** The suggestion rounds UP to the next 50p. */
const SUGGESTION_STEP_PENCE = 50;
/** £1,000 a game: a typo guard for the venue cost, not a price list. */
export const MAX_VENUE_PENCE = 100_000;
/** The pay-by default: three days before the first game, at 21:00 London. */
const PAY_BY_DAYS_BEFORE = 3;
const PAY_BY_TIME = "21:00";

/** Venue cost per game over the regulars, rounded up to the next 50p.
 *  Only a suggestion: the organiser types the share (D1). */
export function suggestSharePence(venueCostPence: number | null | undefined, regulars: number): number | null {
  if (venueCostPence == null || venueCostPence <= 0 || regulars <= 0) return null;
  return Math.ceil(venueCostPence / regulars / SUGGESTION_STEP_PENCE) * SUGGESTION_STEP_PENCE;
}

/** Three days before the first game at 21:00 London ("by Friday" for a
 *  Monday game). For a month already under way: three days from now. */
export function defaultPayBy(firstKickoff: Date, now: Date): Date {
  const before = londonDateTimeToUtc(shiftDay(londonDay(firstKickoff), -PAY_BY_DAYS_BEFORE), PAY_BY_TIME);
  if (before.getTime() > now.getTime()) return before;
  return londonDateTimeToUtc(shiftDay(londonDay(now), PAY_BY_DAYS_BEFORE), PAY_BY_TIME);
}

/**
 * The club fee in month terms (plan 4.2 and 11.3): what each regular's
 * share would carry to cover it, rounded up to 5p a game. A tip only;
 * nothing is ever added to a share automatically.
 */
export function monthFeeShare(p: { pricePence: number | null | undefined; regulars: number; games: number }): { perGamePence: number; perMonthPence: number } | null {
  if (p.pricePence == null || p.pricePence <= 0 || p.regulars <= 0 || p.games <= 0) return null;
  const perGamePence = Math.max(5, Math.ceil(p.pricePence / (p.regulars * p.games) / 5) * 5);
  return { perGamePence, perMonthPence: perGamePence * p.games };
}

export interface PricingInput {
  sharePence: number;
  /** Null: a concession pays the standard share. */
  concessionPence: number | null;
  /** Per game. Bookkeeping only (the suggestion and the summary). */
  venueCostPence: number | null;
  payByAt: Date;
}

export type PricingError = "bad-share" | "bad-concession" | "bad-venue" | "bad-pay-by";

const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PER_GAME_PENCE;

/** One bad field refuses the whole price: nothing is ever half saved. */
export function validatePricing(input: PricingInput, now: Date): { ok: true } | { ok: false; error: PricingError } {
  if (!isPrice(input.sharePence)) return { ok: false, error: "bad-share" };
  if (input.concessionPence !== null && !(isPrice(input.concessionPence) && input.concessionPence <= input.sharePence)) {
    return { ok: false, error: "bad-concession" };
  }
  const v = input.venueCostPence;
  if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_VENUE_PENCE)) return { ok: false, error: "bad-venue" };
  if (!(input.payByAt instanceof Date) || Number.isNaN(input.payByAt.getTime()) || input.payByAt.getTime() <= now.getTime()) {
    return { ok: false, error: "bad-pay-by" };
  }
  return { ok: true };
}

export interface PricingMember {
  userId: string;
  kind: "regular" | "payg";
  tier: "standard" | "concession";
  waiting: boolean;
  /** Off the month (`leftAt`). */
  out: boolean;
  gamesCovered: number;
  /** Credits already used against this month. */
  creditsApplied: number;
  paid: "none" | "claimed" | "confirmed";
}

/** A credit that may be used: not voided, not used, and for a game that
 *  has been played (or not tied to a game at all). */
export interface UsableCredit {
  id: string;
  userId: string;
  createdAt: Date;
}

export interface PricedRow {
  userId: string;
  /** The credits to mark as used against this month, oldest first. */
  creditIds: string[];
  /** The member's new total of credits used against this month. */
  creditsApplied: number;
  amountDuePence: number;
}

const owesForMonth = (m: PricingMember): boolean => m.kind === "regular" && !m.waiting && !m.out;

/**
 * What each regular owes: `share x (games covered - credits)`.
 *
 *  - credits are taken oldest first and never below zero; any surplus
 *    stays in the ledger for the month after;
 *  - a concession pays the concession share when there is one;
 *  - PAYG players, people waiting and people off the month owe nothing for
 *    the month, and none of their credits is touched;
 *  - a regular who has paid, or says so, is NOT re-priced and takes no
 *    more credits: what they were asked for stands.
 */
export function planPricing(p: { members: PricingMember[]; credits: UsableCredit[]; sharePence: number; concessionPence: number | null }): PricedRow[] {
  const rows: PricedRow[] = [];
  for (const m of p.members) {
    if (!owesForMonth(m) || m.paid !== "none") continue;
    const room = Math.max(0, m.gamesCovered - m.creditsApplied);
    const mine = p.credits
      .filter((c) => c.userId === m.userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, room);
    const creditsApplied = m.creditsApplied + mine.length;
    const share = m.tier === "concession" && p.concessionPence !== null ? p.concessionPence : p.sharePence;
    rows.push({
      userId: m.userId,
      creditIds: mine.map((c) => c.id),
      creditsApplied,
      amountDuePence: share * Math.max(0, m.gamesCovered - creditsApplied),
    });
  }
  return rows;
}

/** Once anybody on the month has paid, or says so, the share is locked
 *  (plan section 7, "Venue price change"). The pay-by date can still move. */
export function priceLocked(members: PricingMember[]): boolean {
  return members.some((m) => owesForMonth(m) && m.paid !== "none");
}

// ── A player's "paid" (plan 4.3) ───────────────────────────────────────

const PAID_PHRASES = new Set([
  "paid",
  "i paid",
  "ive paid",
  "i ve paid",
  "i have paid",
  "all paid",
  "paid now",
  "paid it",
  "payment sent",
  "payment made",
  "sent",
  "sent it",
  "transferred",
  "odedim",
  "odeme yaptim",
  "odemeyi yaptim",
  "gonderdim",
  "havale yaptim",
  "yatirdim",
]);

/**
 * Is this DM a player saying they have paid, in the fixed vocabulary?
 * The whole message: "paid", "I've paid", "paid £37.50", "ödedim". A
 * question, a "not paid yet" and "paid for Tom too" are not. Returns the
 * amount when one is written. A CLAIM, never a confirmation.
 */
export function readPaidMessage(text: string | null | undefined): { amountPence: number | null } | null {
  const raw = text ?? "";
  if (raw.includes("?")) return null;
  const folded = foldListText(raw)
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}£.,\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(.*?)(?:\s+£?\s?(\d{1,4})(?:[.,](\d{1,2}))?)?[.,]?$/u.exec(folded);
  if (!m) return null;
  const phrase = m[1].replace(/[.,£]+/g, " ").replace(/\s+/g, " ").trim();
  if (!PAID_PHRASES.has(phrase)) return null;
  const amountPence = m[2] !== undefined ? Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0")) : null;
  return { amountPence };
}

// ── The collector's reply (plan 4.3, D3) ───────────────────────────────

export type CollectorReply = { kind: "all" } | { kind: "none" } | { kind: "numbers"; numbers: number[] };

const REPLY_VERB = new Set(["paid", "odendi"]);
const REPLY_ALL = new Set(["all", "hepsi", "tumu"]);
const REPLY_NONE = new Set(["none", "hicbiri", "yok"]);
const REPLY_JOINER = new Set(["and", "ve"]);

/**
 * The collector's answer to "N say they've paid": "PAID ALL", "PAID 1 3"
 * (their numbers on the month's list), "PAID NONE"; in Turkish "ÖDENDİ
 * HEPSİ", "ÖDENDİ 1 3", "ÖDENDİ HİÇBİRİ".
 *
 * The word PAID is required, and the whole message must be the phrase. A
 * stray "ok", a "yes", a thumbs up or a bare "1 3" (which is how an
 * organiser picks a waiting player) is NEVER a confirmation of money.
 */
export function readCollectorReply(text: string | null | undefined): CollectorReply | null {
  const tokens = foldListText(text ?? "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  if (tokens.length < 2 || tokens.length > 40 || !REPLY_VERB.has(tokens[0])) return null;
  const rest = tokens.slice(1);
  if (rest.length === 1 && REPLY_ALL.has(rest[0])) return { kind: "all" };
  if (rest.length === 1 && REPLY_NONE.has(rest[0])) return { kind: "none" };
  const numbers: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (/^\d{1,2}$/.test(tok)) {
      const n = Number(tok);
      if (n < 1) return null;
      numbers.push(n);
    } else if (!(REPLY_JOINER.has(tok) && i > 0 && i < rest.length - 1 && /^\d{1,2}$/.test(rest[i + 1]))) {
      return null;
    }
  }
  return numbers.length > 0 ? { kind: "numbers", numbers: [...new Set(numbers)] } : null;
}

export interface WaitingClaim {
  userId: string;
  /** Their number on the month's list. */
  slot: number | null;
  claimedAt: Date;
}

/** A reply counts against a digest for two days. */
export const DIGEST_REPLY_WINDOW_MS = 2 * DAY_MS;

export type CollectorDecision =
  | { kind: "confirm"; userIds: string[] }
  | { kind: "decline"; userIds: string[] }
  | { kind: "unknown-numbers"; numbers: number[] }
  | { kind: "no-digest" }
  | { kind: "nothing-waiting" };

/**
 * What the collector's reply does. Only ever to claims the LAST DIGEST
 * showed them (made before it was sent): "ALL" can never confirm a claim
 * the collector has not been shown. A number that is not one of those
 * claims confirms nothing at all, so a typo cannot mark the wrong person.
 */
export function decideCollectorReply(p: { reply: CollectorReply; claims: WaitingClaim[]; digestAt: Date | null; now: Date }): CollectorDecision {
  if (!p.digestAt || p.now.getTime() - p.digestAt.getTime() > DIGEST_REPLY_WINDOW_MS) return { kind: "no-digest" };
  const shown = p.claims.filter((c) => c.claimedAt.getTime() <= p.digestAt!.getTime());
  if (shown.length === 0) return { kind: "nothing-waiting" };
  if (p.reply.kind === "all") return { kind: "confirm", userIds: shown.map((c) => c.userId) };
  if (p.reply.kind === "none") return { kind: "decline", userIds: shown.map((c) => c.userId) };
  const bySlot = new Map(shown.filter((c) => c.slot != null).map((c) => [c.slot as number, c.userId]));
  const unknown = p.reply.numbers.filter((n) => !bySlot.has(n));
  if (unknown.length > 0) return { kind: "unknown-numbers", numbers: unknown };
  return { kind: "confirm", userIds: p.reply.numbers.map((n) => bySlot.get(n)!) };
}

// ── Reminders (plan 4.3 and section 8) ─────────────────────────────────

/** The second DM is never within six hours of the first. */
const SECOND_DM_GAP_MS = 6 * HOUR_MS;
/** "Chased once a day for 3 more days by DM, then silent." */
export const LATE_CHASE_DAYS = 3;
const DIGEST_FROM_HOUR = 10;

export interface RemindersSent {
  r1At: Date | null;
  r2At: Date | null;
  /** The London days a late chase went out on. */
  lateDays: string[];
}

/**
 * Which payment DM one unpaid regular is due right now:
 *   "r1"    from 24 hours before the pay-by date;
 *   "r2"    on the deadline's own day, at least six hours after the first;
 *   "late"  after the deadline, once a London day, on each of the three
 *           days that follow; then nothing.
 * Never between 22:00 and 07:59 London. Each is sent under its own key,
 * so none is ever sent twice.
 */
export function duePaymentReminder(p: { now: Date; payByAt: Date; sent: RemindersSent }): "r1" | "r2" | "late" | null {
  if (!isDaytime(p.now)) return null;
  const t = p.now.getTime();
  const due = p.payByAt.getTime();
  if (t < due - DAY_MS) return null;
  if (t < due) {
    if (!p.sent.r1At) return "r1";
    if (!p.sent.r2At && londonDay(p.now) === londonDay(p.payByAt) && t - p.sent.r1At.getTime() >= SECOND_DM_GAP_MS) return "r2";
    return null;
  }
  const today = londonDay(p.now);
  const after = daysBetween(londonDay(p.payByAt), today);
  if (after < 1 || after > LATE_CHASE_DAYS) return null;
  if (p.sent.lateDays.includes(today) || p.sent.lateDays.length >= LATE_CHASE_DAYS) return null;
  return "late";
}

/** The group's count ("4 still to pay for November by Fri 30 Oct"): once,
 *  in the last 24 hours before the pay-by date, in waking hours. */
export function groupReminderDue(p: { now: Date; payByAt: Date; sent: boolean; unpaid: number }): boolean {
  const t = p.now.getTime();
  const due = p.payByAt.getTime();
  return !p.sent && p.unpaid > 0 && t >= due - DAY_MS && t < due && isDaytime(p.now);
}

/** The collector's digest of claims: once a London day, from 10:00, in
 *  waking hours, while a claim is waiting for their word. */
export function claimsDigestDue(p: { now: Date; sentToday: boolean; waiting: number }): boolean {
  return !p.sentToday && p.waiting > 0 && isDaytime(p.now) && Number(formatLondon(p.now, "H")) >= DIGEST_FROM_HOUR;
}
