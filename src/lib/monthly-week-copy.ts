/**
 * Monthly squad, slice 5: the words of the weekly flow (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 5.3, 5.4 and 6.2.
 *
 * Pure: a `WeekList` (or a few facts) in, a string out, from the club's
 * string table. Nothing here reads a database or calls a model, and none
 * of it is ever sent for a club on "weekly".
 *
 * The list is written the way the group writes it, so a member can copy
 * it, change a line and paste it back: `parseMonthlyList` reads this
 * exact text (the round trip is pinned in `monthly-week-copy.test.ts`).
 */
import { dayCommaTimeLabel, monthNameLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { isMonthListHeader } from "./monthly-list";
import { isCantPlayHeader, readListLine } from "./pasted-roster";
import type { Lang } from "./i18n/lang";
import type { WeekList, WeekName } from "./monthly-week-rules";

type LangArg = Lang | string | null | undefined;

/** The group's own word for "pays per game", the same in every language,
 *  and the mark the list reader looks for. */
const PAYG_MARK = "(PAYG)";

/** 800 is "£8", 750 is "£7.50". Null when the club has set no price. */
export function paygPriceLabel(pence: number | null | undefined): string | null {
  if (pence == null) return null;
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

/**
 * The week's list, in one message (plan 5.4):
 *
 *     📋 List for October: Mon 12 Oct, 20:00
 *
 *     1. Alex (paid)
 *     6. Omar (PAYG)
 *     10.
 *
 *     Paid but can't play
 *     1. Sam
 *
 * A blank slot is shown blank, as the group does. "(paid)" is shown as
 * soon as it is claimed (D3); a regular who has NOT paid and is out is
 * listed under "Can't play", never under the paid header.
 */
export function buildWeekListPost(p: {
  list: WeekList;
  matchDate: Date;
  paygPricePence: number | null | undefined;
  /** The club's organisers pick who fills a place (slice 2b). */
  organiserPicks?: boolean;
  lang?: LangArg;
}): string {
  const s = t(p.lang);
  const lines: string[] = [
    s.mwk_list_header({ month: monthNameLabel(p.lang, p.matchDate), when: dayCommaTimeLabel(p.lang, p.matchDate) }),
    "",
  ];
  for (const slot of p.list.slots) {
    if (!slot.userId) {
      lines.push(`${slot.slot}.`);
      continue;
    }
    const mark = slot.mark === "paid" ? ` ${s.mwk_list_paid}` : slot.mark === "payg" ? ` ${PAYG_MARK}` : "";
    lines.push(`${slot.slot}. ${slot.name || s.unnamed}${mark}`);
  }
  const section = (title: string, names: WeekName[]): void => {
    if (names.length === 0) return;
    lines.push("", title);
    names.forEach((n, i) => lines.push(`${i + 1}. ${n.name || s.unnamed}`));
  };
  section(s.mwk_list_cant_play_paid, p.list.paidCantPlay);
  section(s.mwk_list_cant_play, p.list.cantPlay);
  section(s.mwk_list_reserves, p.list.reserves);
  if (p.list.open > 0) {
    lines.push(
      "",
      p.organiserPicks
        ? s.mwk_list_open_organiser({ open: p.list.open })
        : s.mwk_list_open({ open: p.list.open, price: paygPriceLabel(p.paygPricePence) }),
    );
  }
  return lines.join("\n");
}

/** A place opened and nobody is waiting: the one group line (plan 5.3). */
export function buildPaygPoolGroupPost(p: { matchDate: Date; paygPricePence: number | null | undefined; lang?: LangArg }): string {
  return t(p.lang).mwk_pool_group({ when: dayCommaTimeLabel(p.lang, p.matchDate), price: paygPriceLabel(p.paygPricePence) });
}

/** The same offer by DM, to each pay-as-you-go player. */
export function buildPaygPoolDm(p: {
  name: string | null;
  activityName: string;
  matchDate: Date;
  paygPricePence: number | null | undefined;
  lang?: LangArg;
}): string {
  return t(p.lang).mwk_pool_dm({
    firstName: p.name ? p.name.trim().split(/\s+/)[0] || null : null,
    activityName: p.activityName,
    when: dayCommaTimeLabel(p.lang, p.matchDate),
    price: paygPriceLabel(p.paygPricePence),
  });
}

/**
 * D4: a member's pasted list changed SOMEBODY ELSE'S line. That player is
 * told, with the one word that undoes it.
 *   "out-paid"  moved to "Paid but can't play"
 *   "out"       taken off (they are not a paid regular)
 *   "in"        added to the list
 */
export function buildPasteUndoDm(p: {
  change: "out-paid" | "out" | "in";
  actorName: string | null;
  activityName: string;
  matchDate: Date;
  lang?: LangArg;
}): string {
  const s = t(p.lang);
  const args = { actor: p.actorName?.trim() || s.unnamed, activityName: p.activityName, when: dayCommaTimeLabel(p.lang, p.matchDate) };
  if (p.change === "in") return s.mwk_dm_added(args);
  return p.change === "out-paid" ? s.mwk_dm_moved_out_paid(args) : s.mwk_dm_moved_out(args);
}

/** To the organisers, at most once a day: an old copy of the list was pasted. */
export function buildPasteIgnoredAdminNotice(p: { actorName: string | null; names: string[]; matchDate: Date; lang?: LangArg }): string {
  const s = t(p.lang);
  return s.mwk_admin_paste_ignored({
    actor: p.actorName?.trim() || s.unnamed,
    names: p.names,
    when: dayCommaTimeLabel(p.lang, p.matchDate),
  });
}

/** To the organisers, or to the admin who pasted it: names on a pasted
 *  list that were not added, and how to add a player. */
export function buildPasteNotAddedNotice(p: { actorName: string | null; names: string[]; matchDate: Date; lang?: LangArg }): string {
  const s = t(p.lang);
  return s.mwk_admin_paste_not_added({
    actor: p.actorName?.trim() || s.unnamed,
    names: p.names,
    when: dayCommaTimeLabel(p.lang, p.matchDate),
  });
}

/** To a non-regular whose early IN gave way to a regular at the seed. */
export function buildSeedBumpedDm(p: { name: string | null; activityName: string; matchDate: Date; lang?: LangArg }): string {
  return t(p.lang).mwk_dm_bumped({
    firstName: p.name ? p.name.trim().split(/\s+/)[0] || null : null,
    activityName: p.activityName,
    when: dayCommaTimeLabel(p.lang, p.matchDate),
  });
}

const RESERVE_HEADER = /^\s*(reserves?|subs?|substitutes?|standby|stand-by)\b\s*:?\s*$/i;

/**
 * What a member typed AROUND the list. The list's own furniture is taken
 * out: its title, its section headers, and the "N places open" line of
 * MatchTime's own post, which a member who copies that post pastes back
 * (and which a model must never read as the sender saying IN).
 */
export function pasteResidual(body: string, ctx: { lang: string | null; maxPlayers: number; paygPricePence: number | null }): string {
  const s = t(ctx.lang);
  const own = new Set<string>([s.mwk_list_cant_play_paid, s.mwk_list_cant_play, s.mwk_list_reserves]);
  const price = paygPriceLabel(ctx.paygPricePence);
  for (let open = 1; open <= Math.max(ctx.maxPlayers, 1); open++) {
    own.add(s.mwk_list_open({ open, price }));
    own.add(s.mwk_list_open({ open, price: null }));
    own.add(s.mwk_list_open_organiser({ open }));
  }
  // A not-playing header only counts BELOW a list line, exactly as the
  // reader decides it: "Can't make it" typed above the list is the sender
  // speaking, and must reach the pipeline.
  const kept: string[] = [];
  let seenListLine = false;
  for (const raw of body.split(/\r?\n/)) {
    if (readListLine(raw)) {
      seenListLine = true;
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    if (isMonthListHeader(line) || RESERVE_HEADER.test(line) || own.has(line)) continue;
    if (seenListLine && isCantPlayHeader(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
