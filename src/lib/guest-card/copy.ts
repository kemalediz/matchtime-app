/**
 * THE GUEST CARD'S WHOLE MESSAGES (2026-11-17): pure, assembled from the
 * words in `src/lib/i18n/guest-card.*.ts`. Every value is a fact the code
 * holds (the club, the kick-off, the format, the venue and its address and
 * map link, the fee, the names on file), never text a model produced.
 * Exact outputs are pinned in `__tests__/copy.test.ts`.
 *
 * The welcome DM carries NO group invite link: a guest plays at least once
 * before he joins the club's group (Kemal, 2026-11-17).
 */
import { dayCommaTimeLabel, dayLabel, longDayTimeLabel } from "../i18n/dates";
import { guestCardCopy } from "../i18n/guest-card";
import type { Lang } from "../i18n/lang";
import { formatLondon } from "../london-time";
import type { PoolFee } from "../pool/offer-copy";

const firstName = (name: string | null | undefined): string | null => name?.trim().split(/\s+/)[0] || null;

export interface GuestGameFacts {
  club: string;
  kickoff: Date;
  /** The game's format as the club names it ("Football 7-a-side"), or null. */
  format: string | null;
  venue: string | null;
  address: string | null;
  mapUrl: string | null;
  fee: PoolFee;
  /** The fee is the club's pay-as-you-go price (a running month). */
  monthly: boolean;
}

/** The guest's one DM: who added him, the game, where, the fee, his place, how to drop out, and that he can ask here. */
export function guestWelcomeDm(
  lang: Lang,
  p: GuestGameFacts & { guestName: string | null; organiser: string | null; status: "in" | "bench"; organiserPicks: boolean },
): string {
  const c = guestCardCopy(lang);
  const venue = p.venue?.trim() || null;
  const address = p.address?.trim() && p.address.trim() !== venue ? p.address.trim() : null;
  const facts = [
    c.welcome_when({ when: longDayTimeLabel(lang, p.kickoff) }),
    p.format?.trim() ? c.welcome_format({ format: p.format.trim() }) : null,
    venue ? c.welcome_venue({ venue }) : address ? c.welcome_venue({ venue: address }) : null,
    venue && address ? address : null,
    p.mapUrl ? c.welcome_map({ url: p.mapUrl }) : null,
    p.fee?.kind === "amount" ? (p.monthly ? c.welcome_fee_payg({ amount: p.fee.amount }) : c.welcome_fee({ amount: p.fee.amount })) : null,
  ].filter((l): l is string => !!l);
  const place = p.status === "in" ? c.welcome_in : p.organiserPicks ? c.welcome_bench_pick : c.welcome_bench;
  return [
    c.welcome_head({ first: firstName(p.guestName), organiser: firstName(p.organiser), club: p.club }),
    facts.join("\n"),
    [place, c.welcome_out, c.welcome_ask].join("\n"),
  ].join("\n\n");
}

export type OrganiserReply =
  | { kind: "in" | "bench" | "already-in" | "already-bench"; name: string; kickoff: Date; now: Date; dm: "sent" | "had" | "none" }
  | { kind: "not-ours" | "no-number" | "no-name" | "no-game" | "no-country-code" }
  | { kind: "ask-game"; games: Array<{ club: string; kickoff: Date }> }
  | { kind: "ask-club"; clubs: string[] }
  | { kind: "elsewhere" | "failed"; name: string };

/** The game kicks off on today's London date. */
export function isTonight(kickoff: Date, now: Date): boolean {
  return formatLondon(kickoff, "yyyy-MM-dd") === formatLondon(now, "yyyy-MM-dd");
}

/** The one reply to the organiser, where he asked (the group, HQ or his DM). */
export function organiserReply(lang: Lang, r: OrganiserReply): string {
  const c = guestCardCopy(lang);
  switch (r.kind) {
    case "not-ours":
      return c.reply_not_ours;
    case "no-number":
      return c.reply_no_number;
    case "no-name":
      return c.reply_no_name;
    case "no-game":
      return c.reply_no_game;
    case "no-country-code":
      return c.reply_no_country_code;
    case "ask-game":
      return c.reply_ask_game({ games: r.games.map((g) => dayCommaTimeLabel(lang, g.kickoff)), example: dayLabel(lang, r.games[r.games.length - 1].kickoff) });
    case "ask-club":
      return c.reply_ask_club({ clubs: r.clubs });
    case "no-country-code":
      return c.reply_no_country_code;
    case "ask-game":
      return c.reply_ask_game({ games: r.games.map((g) => dayCommaTimeLabel(lang, g.kickoff)), example: dayLabel(lang, r.games[r.games.length - 1].kickoff) });
    case "ask-club":
      return c.reply_ask_club({ clubs: r.clubs });
    case "no-country-code":
      return c.reply_no_country_code;
    case "ask-game":
      return c.reply_ask_game({ games: r.games.map((g) => dayCommaTimeLabel(lang, g.kickoff)), example: dayLabel(lang, r.games[r.games.length - 1].kickoff) });
    case "ask-club":
      return c.reply_ask_club({ clubs: r.clubs });
    case "elsewhere":
      return c.reply_elsewhere({ name: r.name });
    case "failed":
      return c.reply_failed({ name: r.name });
    default: {
      const day = { name: r.name, day: dayLabel(lang, r.kickoff), tonight: isTonight(r.kickoff, r.now) };
      if (r.kind === "in") {
        const head = c.reply_in(day);
        return r.dm === "sent" ? `${head}${c.reply_dm_sent_after_add}` : r.dm === "had" ? `${head}. ${c.reply_dm_had}` : `${head}.`;
      }
      const head = r.kind === "bench" ? c.reply_bench(day) : r.kind === "already-in" ? c.reply_already_in(day) : c.reply_already_bench(day);
      return r.dm === "sent" ? `${head}. ${c.reply_dm_sent}` : r.dm === "had" ? `${head}. ${c.reply_dm_had}` : `${head}.`;
    }
  }
}

/** His DM once he gave his place back. */
export function guestOutDm(lang: Lang, p: { club: string; kickoff: Date }): string {
  return guestCardCopy(lang).out_dm({ club: p.club, day: dayCommaTimeLabel(lang, p.kickoff) });
}

/** The club's notice when he gives his place back: his name, never his number. */
export function guestOutNotice(lang: Lang, p: { name: string; organiser: string | null; kickoff: Date }): string {
  return guestCardCopy(lang).out_notice({ name: p.name, organiser: firstName(p.organiser), day: dayCommaTimeLabel(lang, p.kickoff) });
}

/** His DM when an organiser takes him off the game: the organisers' words. */
export function guestRemovedDm(lang: Lang, p: { club: string; kickoff: Date }): string {
  return guestCardCopy(lang).removed_dm({ club: p.club, day: dayCommaTimeLabel(lang, p.kickoff) });
}

/** His DM when an organiser takes him off the game: the organisers' words. */
export function guestRemovedDm(lang: Lang, p: { club: string; kickoff: Date }): string {
  return guestCardCopy(lang).removed_dm({ club: p.club, day: dayCommaTimeLabel(lang, p.kickoff) });
}

/** His DM when an organiser takes him off the game: the organisers' words. */
export function guestRemovedDm(lang: Lang, p: { club: string; kickoff: Date }): string {
  return guestCardCopy(lang).removed_dm({ club: p.club, day: dayCommaTimeLabel(lang, p.kickoff) });
}
