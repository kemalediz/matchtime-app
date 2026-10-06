/**
 * Monthly squad, slice 4: the words of the month's price and payments
 * (2026-10-06). Plan: MDs/monthly-squad-plan-2026-10-05.md, 4.2 and 4.3.
 *
 * Pure: facts in, a string out, from the club's string table. Nothing
 * here reads a database or calls a model, and none of it is ever sent
 * for a club on "weekly".
 *
 * The priced list is written the way the group writes it, so a member can
 * copy it, add "(paid)" after their name and paste it back:
 * `parseMonthlyList` reads this exact text (an amount in brackets is not a
 * mark; "(paid £37.50)" is). Pinned in `month-payment-copy.test.ts`.
 */
import { dayCommaTimeLabel, monthNameLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import { gameDaysLabel } from "./month-signup-copy";
import type { SignupList } from "./month-signup-rules";

type LangArg = Lang | string | null | undefined;

/** 800 is "£8", 750 is "£7.50", 20 is "20p". */
export function pounds(pence: number): string {
  if (pence > 0 && pence < 100) return `${pence}p`;
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

const firstNameOf = (name: string | null | undefined): string | null => (name ? name.trim().split(/\s+/)[0] || null : null);

/** What the priced list shows beside one regular. */
export interface PricedLine {
  amountDuePence: number | null;
  /** "claimed" is shown as paid as soon as it is said (D3). */
  paid: "none" | "claimed" | "confirmed";
  /** What was confirmed, else what was claimed, else null. */
  paidPence: number | null;
}

/**
 * The priced list, in one message (plan 4.2):
 *
 *     📋 List for November: £7.50 a game, pay Sam by Fri 30 Oct, 21:00
 *     (5 games = £37.50. Credits are already taken off.)
 *
 *     1. Alex Carter (£37.50)
 *     2. Bilal Aydin (paid £30)
 *
 *     Payment: bank details are in the group description.
 *     Paid? Add (paid) after your name and paste the list, or DM me "paid".
 */
export function buildPricedListPost(p: {
  list: SignupList;
  /** By user id: every regular on the list. */
  lines: ReadonlyMap<string, PricedLine>;
  kickoffs: Date[];
  sharePence: number;
  payByAt: Date;
  collectorName: string | null;
  /** The club's own free text. Never account numbers MatchTime asked for. */
  instructions: string | null;
  lang?: LangArg;
}): string {
  const s = t(p.lang);
  const out: string[] = [
    s.mpy_priced_header({
      month: monthNameLabel(p.lang, p.kickoffs[0]),
      share: pounds(p.sharePence),
      when: dayCommaTimeLabel(p.lang, p.payByAt),
      collector: firstNameOf(p.collectorName),
    }),
    s.mpy_priced_sub({ games: p.kickoffs.length, full: pounds(p.sharePence * p.kickoffs.length) }),
    "",
  ];
  for (const slot of p.list.slots) {
    if (!slot.userId) {
      out.push(`${slot.slot}.`);
      continue;
    }
    const line = p.lines.get(slot.userId);
    const name = slot.name || s.unnamed;
    if (line && line.paid !== "none") {
      const amount = line.paidPence ?? line.amountDuePence;
      out.push(`${slot.slot}. ${name} ${amount != null ? s.mpy_list_paid_amount({ amount: pounds(amount) }) : s.mwk_list_paid}`);
    } else if (line?.amountDuePence != null) {
      out.push(`${slot.slot}. ${name} (${pounds(line.amountDuePence)})`);
    } else {
      out.push(`${slot.slot}. ${name}`);
    }
  }
  // The regulars only: PAYG players and people waiting owe nothing for
  // the month, and the list of who plays each week is the week's own.
  out.push("");
  const instructions = oneLine(p.instructions);
  if (instructions) out.push(s.mpy_priced_instructions({ text: instructions }));
  out.push(s.mpy_priced_how);
  return out.join("\n");
}

/** The club's text on ONE line: a line of its own that began with a number
 *  would be read back as a place on the list. */
function oneLine(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
  return flat === "" ? null : flat;
}

/** 24 hours before the pay-by date, in the group: the count only. */
export function buildGroupPayReminder(p: { count: number; monthDate: Date; payByAt: Date; lang?: LangArg }): string {
  return t(p.lang).mpy_group_reminder({ count: p.count, month: monthNameLabel(p.lang, p.monthDate), when: dayCommaTimeLabel(p.lang, p.payByAt) });
}

/** To one unpaid regular: the amount, how it was worked out, how to pay. */
export function buildPayReminderDm(p: {
  kind: "r1" | "r2" | "late";
  name: string | null;
  monthDate: Date;
  amountDuePence: number;
  games: number;
  credits: number;
  payByAt: Date;
  collectorName: string | null;
  instructions: string | null;
  lang?: LangArg;
}): string {
  return t(p.lang).mpy_dm_reminder({
    kind: p.kind,
    firstName: firstNameOf(p.name),
    month: monthNameLabel(p.lang, p.monthDate),
    amount: pounds(p.amountDuePence),
    games: p.games,
    credits: p.credits,
    when: dayCommaTimeLabel(p.lang, p.payByAt),
    collector: firstNameOf(p.collectorName),
    instructions: p.instructions?.trim() || null,
  });
}

/** To a player who said "paid": noted, and who confirms. */
export function buildPaidClaimAckDm(p: { name: string | null; amountPence: number | null; monthDate: Date; collectorName: string | null; lang?: LangArg }): string {
  return t(p.lang).mpy_dm_claim_ack({
    firstName: firstNameOf(p.name),
    amount: p.amountPence != null ? pounds(p.amountPence) : null,
    month: monthNameLabel(p.lang, p.monthDate),
    collector: firstNameOf(p.collectorName),
  });
}

/** The club fee tip, in month terms. */
export function buildMonthFeeTip(p: { pricePence: number; regulars: number; games: number; perGamePence: number; perMonthPence: number; lang?: LangArg }): string {
  return t(p.lang).mpy_fee_tip({
    price: pounds(p.pricePence),
    regulars: p.regulars,
    games: p.games,
    perGame: pounds(p.perGamePence),
    perMonth: pounds(p.perMonthPence),
  });
}

/** To the organisers: numbers are in, set the price. */
export function buildPriceAskNotice(p: { monthDate: Date; regulars: number; payg: number; link: string; tip: string | null; lang?: LangArg }): string {
  return t(p.lang).mpy_admin_price_ask({ month: monthNameLabel(p.lang, p.monthDate), regulars: p.regulars, payg: p.payg, link: p.link, tip: p.tip });
}

export interface DigestClaim {
  slot: number | null;
  name: string;
  /** What they said they paid, else what they owe. */
  amountPence: number | null;
}

/** To the collector: who says they have paid, by their list number. */
export function buildClaimsDigest(p: { claims: DigestClaim[]; monthDate: Date; lang?: LangArg }): string {
  const s = t(p.lang);
  return s.mpy_digest({
    count: p.claims.length,
    month: monthNameLabel(p.lang, p.monthDate),
    lines: p.claims.map((c) => `${c.slot ?? "?"}. ${c.name || s.unnamed}${c.amountPence != null ? ` ${pounds(c.amountPence)}` : ""}`),
  });
}

/** The answer to the collector's reply. */
export function buildCollectorReplyAnswer(
  p:
    | { kind: "confirmed" | "declined"; names: string[]; monthDate: Date; lang?: LangArg }
    | { kind: "unknown-numbers"; numbers: number[]; monthDate: Date; lang?: LangArg }
    | { kind: "nothing"; lang?: LangArg },
): string {
  const s = t(p.lang);
  if (p.kind === "nothing") return s.mpy_reply_no_digest;
  const month = monthNameLabel(p.lang, p.monthDate);
  if (p.kind === "unknown-numbers") return s.mpy_reply_unknown({ numbers: p.numbers.join(", "), month });
  return p.kind === "confirmed" ? s.mpy_reply_confirmed({ month, names: p.names }) : s.mpy_reply_declined({ month, names: p.names });
}

/** After the pay-by date, to the organisers: who paid, who says so, who has not. */
export function buildPayBySummary(p: {
  monthDate: Date;
  confirmed: { count: number; totalPence: number };
  claimed: string[];
  unpaid: string[];
  /** The month's shares against the venue cost, when one was entered. */
  venue: { duePence: number; venuePence: number } | null;
  lang?: LangArg;
}): string {
  const s = t(p.lang);
  const names = (list: string[]) => (list.length > 0 ? list.join(", ") : s.mpy_none);
  const lines = [
    s.mpy_summary_head({ month: monthNameLabel(p.lang, p.monthDate) }),
    s.mpy_summary_confirmed({ count: p.confirmed.count, total: pounds(p.confirmed.totalPence) }),
    s.mpy_summary_claimed({ count: p.claimed.length, names: names(p.claimed) }),
    s.mpy_summary_unpaid({ count: p.unpaid.length, names: names(p.unpaid) }),
  ];
  if (p.venue) lines.push(s.mpy_summary_venue({ due: pounds(p.venue.duePence), venue: pounds(p.venue.venuePence) }));
  return lines.join("\n");
}

export { gameDaysLabel };
