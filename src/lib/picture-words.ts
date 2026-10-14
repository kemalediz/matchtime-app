/**
 * PICTURE READING: THE CAPTION WORDS (2026-10-14). The one list.
 *
 * A picture posted in a club's group is read only when it is likely to be
 * about the game, so that memes and holiday photos never reach a model.
 * Two ways in (picture-reading.ts): the sender is an owner or admin of the
 * club, OR the caption reads like a list, a team sheet or a result. This
 * module is the second half, English and Turkish side by side.
 *
 * Whole words only: "playlist", "teammate" and "steam" do not count. A word
 * here only lets a picture be LOOKED AT; the model still answers "Not about
 * the game" for anything that is not, and nothing is done with that.
 */

export const PICTURE_CAPTION_WORDS = {
  en: [
    "list",
    "squad",
    "team",
    "teams",
    "team sheet",
    "lineup",
    "line-up",
    "line up",
    "players",
    "starting",
    "result",
    "results",
    "score",
    "final score",
    "fixture",
    "fixtures",
    "kick off",
    "kick-off",
    "kickoff",
    "match",
    "game",
  ],
  tr: [
    "liste",
    "listesi",
    "kadro",
    "kadrosu",
    "takım",
    "takımlar",
    "takimlar",
    "takim",
    "ilk 11",
    "oyuncular",
    "oyuncuları",
    "oyuncular",
    "maç",
    "mac",
    "maçı",
    "sonuç",
    "sonuc",
    "sonucu",
    "skor",
    "fikstür",
    "fikstur",
    "halı saha",
    "hali saha",
  ],
} as const;

/** Only the start of a caption is looked at: enough for any real caption. */
const MAX_CAPTION_CHARS = 500;

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]*");
}

const ALL_WORDS = [...PICTURE_CAPTION_WORDS.en, ...PICTURE_CAPTION_WORDS.tr];
const PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ALL_WORDS.map(escape).join("|")})(?![\\p{L}])`, "u");

/** Does this caption read like a list, a team sheet or a result? */
export function captionLooksAboutGame(caption: string | null | undefined): boolean {
  if (typeof caption !== "string") return false;
  const text = caption.slice(0, MAX_CAPTION_CHARS).toLocaleLowerCase("tr").normalize("NFC");
  if (!text.trim()) return false;
  // Turkish lower-casing turns "I" into dotless "ı"; English words want "i".
  return PATTERN.test(text) || PATTERN.test(caption.slice(0, MAX_CAPTION_CHARS).toLowerCase());
}
