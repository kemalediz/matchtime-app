/**
 * Monthly squad, slice 5: the words of the weekly flow (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 5.3, 5.4 and 6.2.
 *
 * Pure: a `WeekList` (or a few facts) in, a string out, from the club's
 * string table. Nothing here reads a database or calls a model, and none
 * of it is ever sent for a club on "weekly".
 *
 * A member can copy the week's list, change a line and paste it back:
 * the monthly reader (a model, `monthly-reader.ts`) reads it, and the
 * numbers on it are the players' real slot numbers.
 */
import { dayCommaTimeLabel, dayTimeLabel, monthNameLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";
import { normaliseName } from "./name-normalise";
import { usableName } from "./player-name-rules";
import type { WeekList, WeekName, WeekSlot } from "./monthly-week-rules";

type LangArg = Lang | string | null | undefined;

/** 800 is "£8", 750 is "£7.50". Null when the club has set no price. */
export function paygPriceLabel(pence: number | null | undefined): string | null {
  if (pence == null) return null;
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

/**
 * The name each person goes by on the week's list: the FIRST name only
 * ("Davide De Sousa" is "Davide", "Cj - Barber Lab" is "Cj"). When two
 * people on the same post share a first name, each gets his surname's
 * initial ("Dan K", "Dan M"), and his whole name when even that is shared.
 * Somebody with no usable name is the club's word for unnamed, never a
 * phone number (the caller has already tried `player-display-name.ts`).
 */
export function weekListFirstNames(people: Array<{ userId: string; name: string | null | undefined }>, lang?: LangArg): Map<string, string> {
  const unnamed = t(lang).unnamed;
  const fold = (x: string) => normaliseName(x);
  const parts = new Map<string, string[]>();
  for (const p of people) {
    if (parts.has(p.userId)) continue;
    const name = usableName(p.name);
    // Words with a letter in them: "Cj - Barber Lab" is ["Cj", "Barber", "Lab"].
    parts.set(p.userId, name ? name.split(" ").filter((w) => /\p{L}/u.test(w)) : []);
  }
  const first = (id: string) => parts.get(id)?.[0] ?? null;
  const withInitial = (id: string) => {
    const w = parts.get(id) ?? [];
    return w.length > 1 ? `${w[0]} ${w[w.length - 1].charAt(0).toLocaleUpperCase(normaliseLang(lang) === "tr" ? "tr" : "en")}` : (w[0] ?? "");
  };
  const out = new Map<string, string>();
  const ids = [...parts.keys()];
  for (const id of ids) {
    const f = first(id);
    if (!f) {
      out.set(id, unnamed);
      continue;
    }
    const sharing = ids.filter((o) => first(o) !== null && fold(first(o)!) === fold(f));
    if (sharing.length === 1) {
      out.set(id, f);
      continue;
    }
    const mine = withInitial(id);
    const clash = sharing.filter((o) => fold(withInitial(o)) === fold(mine)).length > 1;
    out.set(id, clash ? (parts.get(id) ?? []).join(" ") : mine);
  }
  return out;
}

/**
 * The week's list, in one message (plan 5.4; reworded 2026-11-03):
 *
 *     📋 *Monday 7-a-side, Mon 12 Oct at 20:00*
 *
 *     *October squad:*
 *     1. Alex
 *     4. Jake
 *
 *     You're all in, no need to say anything. Can't make it? Say *Out* and your place opens up.
 *
 *     *Can't play:*
 *     1. Sam
 *
 *     *Pay as you go:*
 *     2. Omar
 *     1 place open, £8. Say *IN* to take it.
 *
 * The squad is the regulars who are in, each under his own slot number
 * (a member who copies the post and blanks a line blanks that slot). A
 * free slot is not printed. Pay-as-you-go players who have a place are
 * listed under "Pay as you go", with the places still open. There are no
 * paid marks: MatchTime does not confirm a payment the organiser takes,
 * so "can't play" is one section whether they have paid or not.
 */
export function buildWeekListPost(p: {
  list: WeekList;
  matchDate: Date;
  /** The fixture's name, as the club's other posts head it ("Monday 7-a-side"). */
  title: string;
  paygPricePence: number | null | undefined;
  /** The club's organisers pick who fills a place (slice 2b). */
  organiserPicks?: boolean;
  lang?: LangArg;
}): string {
  const s = t(p.lang);
  const cantPlay = [...p.list.paidCantPlay, ...p.list.cantPlay];
  const placed = p.list.slots.filter((slot): slot is WeekSlot & { userId: string } => slot.userId !== null);
  const squad = placed.filter((slot) => slot.mark !== "payg");
  const payg = placed.filter((slot) => slot.mark === "payg");
  const shown = weekListFirstNames([...placed, ...cantPlay, ...p.list.reserves], p.lang);
  const nameOf = (userId: string) => shown.get(userId) ?? s.unnamed;
  const price = paygPriceLabel(p.paygPricePence);

  // The title line has no words to translate: the fixture, then the game
  // in the club's language ("Mon 9 Nov at 20:30", "9 Kasım Pazartesi 20:30").
  const lines: string[] = [`📋 *${p.title.trim()}, ${dayTimeLabel(p.lang, p.matchDate)}*`];
  if (squad.length > 0) {
    lines.push("", s.mwk_list_squad({ month: monthNameLabel(p.lang, p.matchDate) }));
    for (const slot of squad) lines.push(`${slot.slot}. ${nameOf(slot.userId)}`);
    lines.push("", s.mwk_list_all_in);
  }
  const section = (title: string, names: WeekName[]): void => {
    if (names.length === 0) return;
    lines.push("", title);
    names.forEach((n, i) => lines.push(`${i + 1}. ${nameOf(n.userId)}`));
  };
  section(s.mwk_list_cant_play, cantPlay);
  section(s.mwk_list_bench, p.list.reserves);

  const open =
    p.list.open > 0
      ? p.organiserPicks
        ? s.mwk_list_open_organiser({ open: p.list.open, price })
        : s.mwk_list_open({ open: p.list.open, price })
      : null;
  if (payg.length > 0) {
    lines.push("", s.mwk_list_payg);
    for (const slot of payg) lines.push(`${slot.slot}. ${nameOf(slot.userId)}`);
    lines.push(open ?? s.mwk_list_full);
  } else {
    lines.push("", open ? `${s.mwk_list_payg} ${open}` : s.mwk_list_full);
  }
  return lines.join("\n");
}

/** A place opened and nobody is waiting: the one group line (plan 5.3). */
export function buildPaygPoolGroupPost(p: {
  /** How many places are open. One line covers them all. Default 1. */
  open?: number;
  matchDate: Date;
  paygPricePence: number | null | undefined;
  lang?: LangArg;
}): string {
  return t(p.lang).mwk_pool_group({
    open: Math.max(1, p.open ?? 1),
    when: dayCommaTimeLabel(p.lang, p.matchDate),
    price: paygPriceLabel(p.paygPricePence),
  });
}

/** To the sender: names on the list they pasted that matched nobody. */
export function buildPasteSenderNotMatchedDm(p: { names: string[]; lang?: LangArg }): string {
  return t(p.lang).mwk_dm_sender_not_matched({ names: p.names });
}

/** To the member whose paste had more guests than one paste may add. */
export function buildPasteGuestsRefusedDm(p: { names: string[]; lang?: LangArg }): string {
  return t(p.lang).mwk_dm_paste_guests_refused({ names: p.names });
}

/** To the member whose paste added guests (B2, 2026-10-29): who, and to
 *  which game. */
export function buildPasteGuestsAddedDm(p: { names: string[]; matchDate: Date; lang?: LangArg }): string {
  return t(p.lang).mwk_dm_paste_guests_added({ names: p.names, when: dayCommaTimeLabel(p.lang, p.matchDate) });
}

/** To a member of the month whose numbered list was not read as the
 *  month's list (no title line, and mostly not this month's players). */
export function buildPasteSenderNotListDm(p: { matchDate: Date; lang?: LangArg }): string {
  return t(p.lang).mwk_dm_sender_not_list({ month: monthNameLabel(p.lang, p.matchDate) });
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

