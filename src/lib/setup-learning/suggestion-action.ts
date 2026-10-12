/**
 * F3, LEARNED SETUP: the "things to check" block of the panel on
 * /admin/settings (2026-10-12). Pure.
 *
 * A suggestion is something the chat shows that MatchTime changed
 * nowhere. Each one carries a button, and the button goes where the
 * organiser's DM sends them for that kind (dm.ts, with the links minted
 * in run.ts):
 *   the weekly game (day, time, pitch, players a side): the weekly game
 *     page, the DM's "Change it here" link;
 *   organisers pick: that setting, further down /admin/settings (the DM
 *     links to the suggestion on the page, which leads there);
 *   the language: the language setting on /admin/settings (the DM links
 *     to the page).
 *
 * Until 2026-10-12 only "organisers pick" had a link on the page: every
 * other kind was a bare line of text, so the kickoff time the DM offered
 * to change had nothing to tap here.
 */
import { t } from "../i18n/t";
import type { SuggestionKey } from "./rules";

/** Where the weekly game is changed: `scheduleUrl` in run.ts. */
export const SCHEDULE_PATH = "/admin/activities";
/** The id of "Who fills an open place" on /admin/settings (pick-mode-rows.tsx). */
export const ORGANISER_PICKS_ANCHOR = "wr-pick";
/** The id of the bot language section on /admin/settings. */
export const LANGUAGE_ANCHOR = "bot-language";

/** Where the suggestion's button goes: a path, or an anchor on the settings page. */
export function suggestionActionHref(key: SuggestionKey): string {
  if (key === "organiserPicks") return `#${ORGANISER_PICKS_ANCHOR}`;
  if (key === "language") return `#${LANGUAGE_ANCHOR}`;
  return SCHEDULE_PATH;
}

/** What the suggestion's button says, in `lang`. */
export function suggestionActionLabel(lang: string | null | undefined, key: SuggestionKey): string {
  return t(lang).settings_learned_action({ key });
}

/** The block's heading: how many suggestions there are, in `lang`. */
export function checkHeading(lang: string | null | undefined, count: number): string {
  return t(lang).settings_learned_check_count({ count });
}
