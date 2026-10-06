/**
 * Monthly squad, slice 6: the words of a cancelled week, a leaver, a share
 * changed after payments, joining part-way and the month's summary
 * (2026-10-06). Plan: MDs/monthly-squad-plan-2026-10-05.md, 4.4 and 7.
 *
 * Pure: facts in, a string out, from the club's string table. Nothing
 * here reads a database or calls a model, and none of it is ever sent
 * for a club on "weekly".
 */
import { dayMonthShortLabel, monthNameLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import { pounds } from "./month-payment-copy";
import type { MonthSummary, ShareChangeRow } from "./month-close-rules";

type LangArg = Lang | string | null | undefined;

const firstNameOf = (name: string | null | undefined): string | null => (name ? name.trim().split(/\s+/)[0] || null : null);

/** The line added to a cancellation announcement for a monthly club: the
 *  regulars are credited. `count` is the number of games called off. */
export function buildCancelCreditLine(p: { count: number; lang?: LangArg }): string {
  return t(p.lang).mcl_cancel_credit({ count: p.count });
}

/** "Sam x2, Rob": a name once, with its count when more than one. */
const timesNames = (people: Array<{ name: string; games: number }>): string =>
  people.map((x) => (x.games > 1 ? `${x.name} x${x.games}` : x.name)).join(", ");

/**
 * The month's summary, as its lines (plan 4.4). The admin notice joins
 * them; the Months page shows them one by one. "Says paid" is never
 * counted as paid.
 *
 *     📒 October summary (4 games played)
 *     Regulars: 12. Paid and confirmed: 11 (£282.50).
 *     Says paid, not confirmed: 1 (Jake £22.50).
 *     PAYG: 6 games played, £48 (4 paid).
 *     PAYG still to chase: 2 (Omar 12 Oct, Will 26 Oct).
 *     Credits carried to a later month: 9 games (Sam x2, Rob).
 *     Credits used this month: 10 games.
 */
export function buildMonthSummaryLines(p: { summary: MonthSummary; monthDate: Date; lang?: LangArg }): string[] {
  const s = t(p.lang);
  const x = p.summary;
  const money = (rows: Array<{ name: string; pence: number | null }>): string =>
    rows.map((r) => (r.pence != null ? `${r.name} ${pounds(r.pence)}` : r.name)).join(", ");
  const out: string[] = [
    s.mcl_sum_head({ month: monthNameLabel(p.lang, p.monthDate), games: x.gamesPlayed }),
    s.mcl_sum_regulars({ count: x.regulars, confirmed: x.confirmed.count, total: pounds(x.confirmed.totalPence) }),
  ];
  if (x.claimed.length > 0) out.push(s.mcl_sum_claimed({ count: x.claimed.length, names: money(x.claimed) }));
  if (x.unpaid.length > 0) out.push(s.mcl_sum_unpaid({ count: x.unpaid.length, names: money(x.unpaid) }));
  if (x.owesMore.length > 0) out.push(s.mcl_sum_owes_more({ names: money(x.owesMore) }));
  if (x.owedBack.length > 0) out.push(s.mcl_sum_owed_back({ names: money(x.owedBack) }));
  if (x.payg.games === 0) out.push(s.mcl_sum_payg_none);
  else {
    out.push(s.mcl_sum_payg({ games: x.payg.games, total: pounds(x.payg.totalPence), paid: x.payg.paid }));
    if (x.payg.toChase.length > 0) {
      out.push(
        s.mcl_sum_payg_chase({
          count: x.payg.toChase.length,
          names: x.payg.toChase.map((g) => `${g.name} ${dayMonthShortLabel(p.lang, g.date)}`).join(", "),
        }),
      );
    }
  }
  if (x.leavers.length > 0) {
    out.push(
      s.mcl_sum_leavers({
        names: x.leavers
          .map((l) => `${s.mcl_sum_owed_games({ name: l.name, games: l.games })}${l.pence != null ? ` (${pounds(l.pence)})` : ""}`)
          .join(", "),
      }),
    );
  }
  out.push(x.carried.games > 0 ? s.mcl_sum_carried({ games: x.carried.games, names: timesNames(x.carried.people) }) : s.mcl_sum_carried_none);
  out.push(s.mcl_sum_used({ games: x.creditsUsed }));
  return out;
}

/** The summary as one admin notice, with the page link when there is one. */
export function buildMonthSummaryNotice(p: { summary: MonthSummary; monthDate: Date; link: string; lang?: LangArg }): string {
  const lines = buildMonthSummaryLines(p);
  if (p.link) lines.push(t(p.lang).mcl_sum_page({ link: p.link }));
  return lines.join("\n");
}

/** To the organisers, once: a regular who paid has left, and what they are owed. */
export function buildLeaverNotice(p: { name: string | null; monthDate: Date; games: number; pence: number | null; link: string; lang?: LangArg }): string {
  const s = t(p.lang);
  return s.mcl_leaver_notice({
    name: p.name || s.unnamed,
    month: monthNameLabel(p.lang, p.monthDate),
    games: p.games,
    amount: p.pence != null ? pounds(p.pence) : null,
    link: p.link,
  });
}

/** To the organisers, once per change: the new share, and who it leaves
 *  owing more or with money to come back. Nobody's payment is changed. */
export function buildShareChangeNotice(p: { rows: ShareChangeRow[]; sharePence: number; monthDate: Date; link: string; lang?: LangArg }): string {
  const s = t(p.lang);
  const owes = p.rows.filter((r) => r.balancePence > 0);
  const back = p.rows.filter((r) => r.balancePence < 0);
  const names = (rows: ShareChangeRow[]): string => rows.map((r) => `${r.name || s.unnamed} ${pounds(Math.abs(r.balancePence))}`).join(", ");
  const out = [s.mcl_share_head({ month: monthNameLabel(p.lang, p.monthDate), share: pounds(p.sharePence) })];
  if (owes.length > 0) out.push(s.mcl_share_owes({ names: names(owes) }));
  if (back.length > 0) out.push(s.mcl_share_back({ names: names(back) }));
  if (owes.length === 0 && back.length === 0) out.push(s.mcl_share_none);
  else out.push(s.mcl_share_foot({ link: p.link }));
  return out.join("\n");
}

/** To a player who joined a month under way: the games left and what to pay. */
export function buildMidMonthJoinDm(p: {
  name: string | null;
  monthDate: Date;
  games: number;
  amountDuePence: number | null;
  collectorName: string | null;
  lang?: LangArg;
}): string {
  return t(p.lang).mcl_midjoin_dm({
    firstName: firstNameOf(p.name),
    month: monthNameLabel(p.lang, p.monthDate),
    games: p.games,
    amount: p.amountDuePence != null && p.amountDuePence > 0 ? pounds(p.amountDuePence) : null,
    collector: firstNameOf(p.collectorName),
  });
}

/** To the organisers, once: somebody joined a month under way. */
export function buildMidMonthJoinNotice(p: { name: string | null; monthDate: Date; games: number; amountDuePence: number | null; link: string; lang?: LangArg }): string {
  const s = t(p.lang);
  return s.mcl_midjoin_admin({
    name: p.name || s.unnamed,
    month: monthNameLabel(p.lang, p.monthDate),
    games: p.games,
    amount: p.amountDuePence != null && p.amountDuePence > 0 ? pounds(p.amountDuePence) : null,
    link: p.link,
  });
}
