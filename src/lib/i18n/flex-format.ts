/**
 * A GAME'S SIZES (2026-11-03, `flex-format-rules.ts`): the fewest and the
 * most players a game is played with, switching one match to another size
 * (by web or by tagging MatchTime), the suggestion to go up a size when two
 * are on the bench, and the DMs to the players a switch moves.
 *
 * One object per language, typed by `FlexFormatCopy`, so a line missing in
 * either language is a `tsc` error. House rules (unit tested in
 * `__tests__/flex-format-copy.test.ts`): no em or en dashes, no slash as a
 * separator, "bench" and never "waiting list", Turkish never equal to
 * English.
 */
import { normaliseLang, type Lang } from "./lang";
import { FLEX_FORMAT_EN } from "./flex-format.en";
import { FLEX_FORMAT_TR } from "./flex-format.tr";

export type RangeRefusal = "odd" | "too-low" | "too-high" | "min-above-places" | "max-below-places" | "not-a-number";

export interface FlexFormatCopy {
  /** "8-a-side" / "8'e 8". */
  side: (perSide: number) => string;
  /** "6, 7 or 8 a side" / "6'ya 6, 7'ye 7 ya da 8'e 8". */
  sides: (perSide: number[]) => string;

  // ── The range, set by an organiser in WhatsApp ──
  /** Set, or changed. `up`: a size above the game's own is allowed. */
  rangeSet: (p: { activityName: string; min: number; max: number; sides: number[]; up: boolean }) => string;
  /** Back to the game's own format only. */
  rangeCleared: (p: { activityName: string; places: number; perSide: number }) => string;
  rangeUnchanged: (p: { activityName: string; min: number; max: number; sides: number[] }) => string;
  rangeRefused: (p: { error: RangeRefusal; field: "min" | "max"; activityName: string; places: number; ceiling: number; url: string }) => string;
  noNumbers: (p: { url: string }) => string;
  whichGame: (p: { names: string[]; url: string }) => string;
  noGame: (p: { url: string }) => string;

  // ── The range, on the activities page ──
  minLabel: string;
  maxLabel: string;
  minHint: (p: { full: number }) => string;
  maxHint: (p: { full: number }) => string;
  /** "With 12 to 16 players you can play 6, 7 or 8 a side." */
  allows: (p: { min: number; max: number; sides: number[] }) => string;
  /** The list row, only when a range is set. */
  row: (p: { sides: number[] }) => string;

  // ── Switching one match ──
  /** `pickOpen`: an organiser-pick club's places now open (nobody moved
   *  in; the pick round asks the organisers). 0 otherwise. */
  switched: (p: { day: string; perSide: number; places: number; promoted: string[]; demoted: string[]; teamsCleared: boolean; pickOpen?: number }) => string;
  /** Switched to another of the club's formats (its own Activity and
   *  kickoff): the announcement goes to the group itself. */
  activitySwitched: (p: { day: string; perSide: number; places: number }) => string;
  /** An organiser's yes to a suggestion that no longer holds. */
  suggestionStale: (p: { day: string; perSide: number }) => string;
  /** A range that would leave out a match already switched. */
  rangeBlocked: (p: { activityName: string; day: string; perSide: number; backTo: number }) => string;
  alreadyThat: (p: { day: string; perSide: number }) => string;
  notAllowed: (p: { activityName: string; perSide: number; sides: number[]; url: string }) => string;
  noRange: (p: { activityName: string; perSide: number; url: string }) => string;
  noSize: string;
  noMatch: string;
  tooLate: string;

  // ── The suggestion in the players' group ──
  suggestUp: (p: { total: number; bench: number; day: string; perSide: number; admins: string }) => string;

  // ── The DMs to the players a switch moves ──
  /** Moved in from the bench. `price`: "£8" when the club takes payments
   *  and sets a pay as you go price, else null. */
  dmIn: (p: { day: string; perSide: number; price: string | null }) => string;
  /** Moved to the bench. */
  dmBench: (p: { day: string; perSide: number; places: number }) => string;

  // ── The new list, for a weekly club ──
  rosterHeader: (p: { day: string; perSide: number; places: number }) => string;
  rosterPlaying: (p: { confirmed: number; places: number }) => string;
  rosterBench: string;
  rosterNobody: string;

  // ── The switch page ──
  pageSizesLabel: string;
  pageSizeButton: (p: { perSide: number; places: number }) => string;
  pageCurrent: (p: { perSide: number; places: number; confirmed: number }) => string;
  pageWillPromote: (p: { count: number }) => string;
  pageWillBench: (p: { count: number }) => string;
  pageConfirm: string;
  pageDone: string;
  /** The activities page: a player box that is not a whole number. */
  pageInvalid: string;
}

const BY_LANG: Record<Lang, FlexFormatCopy> = { en: FLEX_FORMAT_EN, tr: FLEX_FORMAT_TR };

export function flexFormatCopy(lang: Lang | string | null | undefined): FlexFormatCopy {
  return BY_LANG[normaliseLang(lang)];
}
