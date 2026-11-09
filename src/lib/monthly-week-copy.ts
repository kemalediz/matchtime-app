/**
 * Monthly squad, slice 5: the words of the weekly flow (2026-10-06).
 * Plan: MDs/monthly-squad-plan-2026-10-05.md, sections 5.3, 5.4 and 6.2.
 *
 * Pure: a `WeekList` (or a few facts) in, a string out, from the club's
 * string table. Nothing here reads a database or calls a model, and none
 * of it is ever sent for a club on "weekly".
 *
 * A member can copy the week's list, change a line and paste it back:
 * the monthly reader (a model, `monthly-reader.ts`) reads it. The numbers
 * on it count 1, 2, 3 with no gaps (Kemal, 2026-11-07), not the players'
 * slot numbers: a pasted copy is read by its names and where its lines
 * sit, never by matching a number to a slot (`monthly-week-rules.ts`).
 */
import { dayCommaTimeLabel, dayTimeLabel, monthNameLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";
import { normaliseName } from "./name-normalise";
import { usableName } from "./player-name-rules";
import { weekListPlaces, type WeekList, type WeekName } from "./monthly-week-rules";
import { flexFormatCopy } from "./i18n/flex-format";

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
 *     2. Jake
 *
 *     *Pay as you go:*
 *     3. Omar
 *     1 place open, £8. Say *IN* to take it.
 *
 *     You're all in, no need to say anything. Can't make it? Say *Out* and your place opens up.
 *
 *     *Can't play:*
 *     1. Sam
 *
 *     *Bench:*
 *     1. Zed
 *
 *     One more on the bench and the organisers can make it 8-a-side.
 *
 * In that order (Kemal, 2026-11-09: pay as you go "right after the
 * squad, not after can't play or bench"): the squad, pay as you go with
 * its places line (that line alone when nobody pays as he goes yet), the
 * squad's own "you're all in" line, can't play, the bench, and the next
 * size last, since it is about the bench. An empty block is left out.
 *
 * The squad is the regulars who are in, in slot order. A free slot, and
 * the slot of a regular who can't play, is not printed, and the numbers
 * count 1, 2, 3 with no gaps (Kemal, 2026-11-07: "10, 11 and 12", not
 * "10, 12"). Pay-as-you-go players who have a place are listed under "Pay
 * as you go", with the places still open, and their numbers carry on from
 * the squad's: everybody with a place this week is one count, so the last
 * number is how many are playing. "Can't play" and the bench are not
 * playing, and each counts from 1. A member who copies the post and
 * blanks a line takes off the player that line was, read by where the
 * blank sits among the names (`reconcileMonthPaste`), not by its number.
 * There are no paid marks: MatchTime does not confirm a payment the
 * organiser takes, so "can't play" is one section whether they have paid
 * or not.
 */
export function buildWeekListPost(p: {
  list: WeekList;
  matchDate: Date;
  /** The fixture's name, as the club's other posts head it ("Monday 7-a-side"). */
  title: string;
  paygPricePence: number | null | undefined;
  /** The club's organisers pick who fills a place (slice 2b). */
  organiserPicks?: boolean;
  /** The daily 17:00 post when the group saw this same list in the last
   *  three hours (2026-11-04): the title line and the places line only, so
   *  the names are not listed twice inside the hour. Never hashed. */
  compact?: boolean;
  /** The next size's players a side when ONE more on the bench would make
   *  MatchTime suggest it (`oneMoreForNextSize`, 2026-11-09): one line
   *  at the end of the list (the compact form: under its squad-full line).
   *  Shown only while no place is open. */
  nextSizePerSide?: number | null;
  lang?: LangArg;
}): string {
  const s = t(p.lang);
  const oneMore = p.nextSizePerSide && p.list.open <= 0 ? flexFormatCopy(p.lang).oneMoreUp({ perSide: p.nextSizePerSide }) : null;
  if (p.compact) {
    const open = weekListOpenLine(p.list.open, paygPriceLabel(p.paygPricePence), p.organiserPicks === true, p.lang);
    const out = [weekListTitleLine(p.title, p.matchDate, p.lang), "", open ? `${s.mwk_list_payg} ${open}` : s.mwk_list_full];
    if (oneMore) out.push(oneMore);
    return out.join("\n");
  }
  const cantPlay = [...p.list.paidCantPlay, ...p.list.cantPlay];
  const { squad, payg } = weekListPlaces(p.list);
  const shown = weekListFirstNames([...squad, ...payg, ...cantPlay, ...p.list.reserves], p.lang);
  const nameOf = (userId: string) => shown.get(userId) ?? s.unnamed;
  const price = paygPriceLabel(p.paygPricePence);

  // The title line has no words to translate: the fixture, then the game
  // in the club's language ("Mon 9 Nov at 20:30", "9 Kasım Pazartesi 20:30").
  const lines: string[] = [weekListTitleLine(p.title, p.matchDate, p.lang)];
  if (squad.length > 0) {
    lines.push("", s.mwk_list_squad({ month: monthNameLabel(p.lang, p.matchDate) }));
    squad.forEach((slot, i) => lines.push(`${i + 1}. ${nameOf(slot.userId)}`));
  }

  // Pay as you go straight after the squad (Kemal, 2026-11-09), its
  // places line closing it: with no PAYG names yet, that line alone.
  const open = weekListOpenLine(p.list.open, price, p.organiserPicks === true, p.lang);
  if (payg.length > 0) {
    lines.push("", s.mwk_list_payg);
    payg.forEach((slot, i) => lines.push(`${squad.length + i + 1}. ${nameOf(slot.userId)}`));
    lines.push(open ?? s.mwk_list_full);
  } else {
    lines.push("", open ? `${s.mwk_list_payg} ${open}` : s.mwk_list_full);
  }

  // The squad's own line ("you're all in"), then who is not playing.
  if (squad.length > 0) lines.push("", s.mwk_list_all_in);
  const section = (title: string, names: WeekName[]): void => {
    if (names.length === 0) return;
    lines.push("", title);
    names.forEach((n, i) => lines.push(`${i + 1}. ${nameOf(n.userId)}`));
  };
  section(s.mwk_list_cant_play, cantPlay);
  section(s.mwk_list_bench, p.list.reserves);

  // The next size is about the bench, so it comes last.
  if (oneMore) lines.push("", oneMore);
  return lines.join("\n");
}

/** The list's title line: the fixture, then the game in the club's
 *  language ("Mon 9 Nov at 20:30", "9 Kasım Pazartesi 20:30"). */
function weekListTitleLine(title: string, matchDate: Date, lang: LangArg): string {
  return `📋 *${title.trim()}, ${dayTimeLabel(lang, matchDate)}*`;
}

/** "1 place open, £8. Say *IN* to take it.", or null when none is open. */
function weekListOpenLine(open: number, price: string | null, organiserPicks: boolean, lang: LangArg): string | null {
  if (open <= 0) return null;
  const s = t(lang);
  return organiserPicks ? s.mwk_list_open_organiser({ open, price }) : s.mwk_list_open({ open, price });
}

/**
 * The daily 17:00 post of a running month (2026-11-04): the month's list
 * as the group knows it (`buildWeekListPost`, or its compact form when the
 * group saw the same list in the last three hours), then the bench ask
 * when the squad is full and the bench is thin. Whether it is due at all,
 * and whether the ask belongs on it, is `decideDailyUpdate`'s call
 * (daily-update-rules.ts); `benchInvite` is
 * `buildSquadCompleteBenchInvite`, the same words as every other bench ask.
 */
export function buildMonthlyDailyPost(p: { listPost: string; benchInvite: string | null }): string {
  return p.benchInvite ? `${p.listPost}\n\n${p.benchInvite}` : p.listPost;
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

