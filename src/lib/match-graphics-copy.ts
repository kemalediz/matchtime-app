/**
 * Every word on the list poster and the team sheet, and every line the
 * admin group hears about them (2026-10-14), in English and Turkish.
 *
 * Kept here rather than in `i18n/strings.*.ts` so the two graphics and
 * their command ship as one self-contained piece; the shape is the same
 * (one table per language, the Turkish one typed against the English one,
 * so a missing key is a build failure). Pure: no clock, no database.
 */
import { normaliseLang, type Lang } from "./i18n/lang";
import { dayLabel } from "./i18n/dates";

const en = {
  /** The poster's title, over the names. */
  listTitle: "SQUAD",
  /** The team sheet's title. */
  teamsTitle: "TEAMS",
  reserves: "RESERVES",
  venue: "VENUE",
  date: "DATE",
  kickoff: "KICKOFF",
  players: (n: number) => (n === 1 ? "1 PLAYER" : `${n} PLAYERS`),
  moreReserves: (n: number) => `+${n} more`,
  /** A player with no usable name (never a phone number on an image). */
  player: "Player",
  /** The Posters card's sample, when the club has no match yet (2026-10-14). */
  sampleVenue: "Your venue",
  /** The caption the image is posted with in the admin group. */
  listCaption: (club: string, day: string) => `Ready to post: ${club} list for ${day}`,
  teamsCaption: (club: string, day: string) => `Ready to post: ${club} teams for ${day}`,
  noTeams: "No teams yet.",
  noMatch: "No upcoming match to make that for.",
  /** A team sheet asked for minutes after the same one was posted (2026-10-30). */
  teamsUnchanged: "The teams have not changed since the team sheet I just posted.",
  /** A DM to the owner when the admin group cannot take the picture. */
  dmFallback: (caption: string, url: string) => `${caption}\nThe picture could not go to the admin group. Open it here (link valid for 24 hours):\n${url}`,
};

export type MatchGraphicsCopy = typeof en;

const tr: MatchGraphicsCopy = {
  listTitle: "KADRO",
  teamsTitle: "TAKIMLAR",
  reserves: "YEDEKLER",
  venue: "SAHA",
  date: "TARİH",
  kickoff: "SAAT",
  players: (n: number) => `${n} OYUNCU`,
  moreReserves: (n: number) => `+${n} kişi daha`,
  player: "Oyuncu",
  sampleVenue: "Sahanız",
  listCaption: (club: string, day: string) => `Paylaşıma hazır: ${club} listesi, ${day}`,
  teamsCaption: (club: string, day: string) => `Paylaşıma hazır: ${club} takımları, ${day}`,
  noTeams: "Henüz takım yok.",
  noMatch: "Bunun için yaklaşan maç yok.",
  teamsUnchanged: "Takımlar, az önce gönderdiğim takım görselinden beri değişmedi.",
  dmFallback: (caption: string, url: string) =>
    `${caption}\nResim yönetici grubuna gönderilemedi. Buradan açabilirsin (bağlantı 24 saat geçerli):\n${url}`,
};

const TABLES: Record<Lang, MatchGraphicsCopy> = { en, tr };

export function graphicsCopy(lang: Lang | string | null | undefined): MatchGraphicsCopy {
  return TABLES[normaliseLang(lang)];
}

export type GraphicKind = "list" | "teams";

/** "Ready to post: FNF list for Fri 16 Oct" / "Paylaşıma hazır: FNF listesi, 16 Ekim Cuma". */
export function graphicCaption(kind: GraphicKind, lang: Lang | string | null | undefined, clubName: string, matchDate: Date): string {
  const s = graphicsCopy(lang);
  const day = dayLabel(lang, matchDate);
  return kind === "list" ? s.listCaption(clubName, day) : s.teamsCaption(clubName, day);
}
