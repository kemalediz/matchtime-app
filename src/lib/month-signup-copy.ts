/**
 * Monthly squad, slice 3: the words of the month's sign-up (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 4.1 and 6.2.
 *
 * Pure: a `SignupList` (or a few facts) in, a string out, from the club's
 * string table. Nothing here reads a database or calls a model, and none
 * of it is ever sent for a club on "weekly".
 *
 * The list is written the way the group writes it, so a member can copy
 * it, add their name and paste it back: `parseMonthlyList` reads this
 * exact text, and `readSignupMessage` reads the words the post tells a
 * member to type (both pinned in `month-signup-copy.test.ts`).
 */
import { appUrl } from "./app-url";
import { dayCommaTimeLabel, monthNameLabel, weekdayLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import { formatLondon } from "./london-time";
import { LANGS } from "./i18n/lang";
import type { SignupList } from "./month-signup-rules";

type LangArg = Lang | string | null | undefined;

/** The path of the player's own sign-up page. */
export const MONTH_PAGE_PATH = "/month";

/** "(PAYG)" or "(PAYG 9, 23)": the group's own mark, the same in every
 *  language, and the one the list reader looks for. */
export function paygMark(days: number[]): string {
  return days.length > 0 ? `(PAYG ${days.join(", ")})` : "(PAYG)";
}

/** "2, 9, 16, 23, 30": the London days of the month's games. */
export function gameDaysLabel(kickoffs: Date[]): string {
  return kickoffs.map((k) => formatLondon(k, "d")).join(", ");
}

export interface SignupPostFacts {
  list: SignupList;
  /** The month's games, as kick-offs, in order. At least one. */
  kickoffs: Date[];
  /** A day in the month the regulars are carried over from. Null: nobody was. */
  carriedFrom: Date | null;
  /** When sign-up ends. */
  endsAt: Date;
  lang?: LangArg;
}

/** The lines under the list. Kept apart so a paste of our own post can be
 *  told from what a member typed around it (`signupPasteResidual`). */
export function footer(p: Omit<SignupPostFacts, "list">): string[] {
  const s = t(p.lang);
  const month = monthNameLabel(p.lang, p.kickoffs[0]);
  const exampleDay = Number(formatLondon(p.kickoffs[Math.min(1, p.kickoffs.length - 1)], "d"));
  return [
    ...(p.carriedFrom ? [`${s.msu_list_carried({ prev: monthNameLabel(p.lang, p.carriedFrom) })} ${s.msu_list_out({ month })}`] : [s.msu_list_out({ month })]),
    s.msu_list_join({ month }),
    s.msu_list_payg({ day: exampleDay }),
    s.msu_list_link({ url: appUrl(MONTH_PAGE_PATH) }),
    s.msu_list_deadline({ when: dayCommaTimeLabel(p.lang, p.endsAt) }),
  ];
}

/**
 * The month's list, in one message (plan 4.1):
 *
 *     📋 List for November (5 Mondays: 2, 9, 16, 23, 30)
 *
 *     1. Alex
 *     2.
 *     15. Omar (PAYG 9)
 *
 *     Reserves
 *     1. Eve
 *
 *     Regulars from October are on already. Not in for November? Say *OUT FOR NOVEMBER*.
 *     ...
 *
 * A blank place is shown blank. PAYG players are numbered on after the
 * regular places. "(paid)" is shown as soon as it is claimed (D3).
 */
export function buildSignupListPost(p: SignupPostFacts): string {
  const s = t(p.lang);
  const first = p.kickoffs[0];
  const lines: string[] = [
    s.msu_list_header({
      month: monthNameLabel(p.lang, first),
      games: p.kickoffs.length,
      weekday: weekdayLabel(p.lang, first),
      days: gameDaysLabel(p.kickoffs),
    }),
    "",
  ];
  for (const slot of p.list.slots) {
    lines.push(slot.userId ? `${slot.slot}. ${slot.name || s.unnamed}${slot.paid ? ` ${s.mwk_list_paid}` : ""}` : `${slot.slot}.`);
  }
  for (const m of p.list.payg) lines.push(`${m.slot}. ${m.name || s.unnamed} ${paygMark(m.days)}`);
  if (p.list.waiting.length > 0) {
    lines.push("", s.mwk_list_reserves);
    p.list.waiting.forEach((w, i) => lines.push(`${i + 1}. ${w.name || s.unnamed}`));
  }
  lines.push("", ...footer(p));
  return lines.join("\n");
}

/** To somebody who asked for a regular place when every one was taken. */
export function buildSignupWaitingDm(p: { name: string | null; monthDate: Date; max: number; lang?: LangArg }): string {
  return t(p.lang).msu_dm_waiting({
    firstName: p.name ? p.name.trim().split(/\s+/)[0] || null : null,
    month: monthNameLabel(p.lang, p.monthDate),
    max: p.max,
  });
}

/** To somebody who signed up as pay-as-you-go: what it means, what happens next. */
export function buildSignupPaygDm(p: { name: string | null; monthDate: Date; days: number[]; lang?: LangArg }): string {
  return t(p.lang).msu_dm_payg({
    firstName: p.name ? p.name.trim().split(/\s+/)[0] || null : null,
    month: monthNameLabel(p.lang, p.monthDate),
    days: p.days.length > 0 ? p.days.join(", ") : null,
  });
}

/** To the organisers, once a month: the regular places are full. */
export function buildSignupWaitingAdminNotice(p: { name: string | null; monthDate: Date; max: number; link: string; lang?: LangArg }): string {
  const s = t(p.lang);
  return s.msu_admin_waiting({ name: p.name?.trim() || s.unnamed, month: monthNameLabel(p.lang, p.monthDate), max: p.max, link: p.link });
}

/** To the member whose pasted list had other people written in. */
export function buildSignupPasteOthersDm(p: { names: string[]; monthDate: Date; lang?: LangArg }): string {
  return t(p.lang).msu_dm_paste_others({ names: p.names, month: monthNameLabel(p.lang, p.monthDate) });
}

/** To a member who says they have paid and then asks to change their place. */
export function buildSignupLockedDm(p: { monthDate: Date; lang?: LangArg }): string {
  return t(p.lang).msu_dm_locked({ month: monthNameLabel(p.lang, p.monthDate) });
}

/** To a PAYG player who named a date with no game. */
export function buildSignupUnknownDaysDm(p: { days: number[]; kickoffs: Date[]; lang?: LangArg }): string {
  return t(p.lang).msu_dm_unknown_days({
    days: p.days.join(", "),
    month: monthNameLabel(p.lang, p.kickoffs[0]),
    games: gameDaysLabel(p.kickoffs),
  });
}
