/**
 * THE NAME A POST GIVES ONE GAME (2026-11-16). Pure.
 *
 * Posts head a game with its Activity's name. Self-join names an activity
 * after the club's usual size ("Football 7-a-side", "7'ye 7 futbol":
 * `sj_activity_name`), and a club may put a size in a name of its own
 * ("Monday 7-a-side"). One game can be played at another size
 * (`format-resize.ts`: "@Match Time switch to 8side" sets Match.maxPlayers
 * to 16 and keeps the activity), and on the Vets' list, 16 Nov 2026, the
 * 16-place game was still headed "Football 7-a-side".
 *
 * So a name that names a size names the size this game is played at,
 * `maxPlayers / 2` a side; everything else in the name stays as the club
 * wrote it. A name with no size in it ("Monday night vets") is returned
 * unchanged, as is every name when the game's size is no whole number a
 * side. This reads MatchTime's own data, never a player's words.
 */
import { t } from "./i18n/t";

/** "7-a-side", "7 a side", "7aside", any case. Group 1 is the number. */
const EN_SIZE = /(?<!\d)(\d{1,2})(\s*-?\s*a\s*-?\s*side)(?![a-z])/i;
/** "7'ye 7", "8'e 8", "6'ya 6", "9'a 9": the Turkish size, always the
 *  dative (`perSideTr`). No other suffix: "7'de 7 kişi" is a time. */
const TR_SIZE = /(?<!\d)(\d{1,2})['’](?:ya|ye|a|e) (\d{1,2})(?![\d\p{L}])/iu;

/** The players a side `maxPlayers` makes, or null when it is no whole number. */
function perSideOf(maxPlayers: number | null | undefined): number | null {
  if (typeof maxPlayers !== "number" || !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers % 2 !== 0) return null;
  return maxPlayers / 2;
}

/**
 * The game's name for a post: `activityName` with the size in it, if
 * any, made the size this match is played at.
 */
export function matchFormatTitle(activityName: string, maxPlayers: number | null | undefined): string {
  const name = typeof activityName === "string" ? activityName : "";
  const perSide = perSideOf(maxPlayers);
  if (perSide === null) return name;

  const tr = TR_SIZE.exec(name);
  if (tr && tr[1] === tr[2]) {
    if (Number(tr[1]) === perSide) return name;
    return name.slice(0, tr.index) + t("tr").sj_per_side_option({ perSide }) + name.slice(tr.index + tr[0].length);
  }
  const en = EN_SIZE.exec(name);
  if (en) {
    if (Number(en[1]) === perSide) return name;
    return name.slice(0, en.index) + String(perSide) + en[2] + name.slice(en.index + en[0].length);
  }
  return name;
}
