/**
 * F3, LEARNED SETUP: IS A SUGGESTION STILL OPEN? (2026-10-12). Pure.
 *
 * A suggestion is written once, when the chat is read: what the club had
 * then (`current`), what the chat showed (`detected`) and the messages
 * behind it. The row is never rewritten, and the organiser's DM is a
 * snapshot of that moment. The settings page is not: the owner moved his
 * kickoff from 20:00 to 20:30 on the weekly game page, came back, and the
 * card still said "your weekly game is set for 20:00", with the same
 * button. So whenever the page is built, every stored suggestion is held
 * against what the club has NOW:
 *
 *   OPEN      the club still has what it had when the chat was read. The
 *             card is shown, worded with the club's value as it is now.
 *   RESOLVED  the club has something else: what the chat showed, or a
 *             third value. Either way the organiser has looked and
 *             decided, so the card leaves the "things to check" block and
 *             a quiet line says what the club has now. A value that is no
 *             longer there at all (no weekly game, no venue) is resolved
 *             too: the card's sentence would no longer be true.
 *
 * The state is worked out on every load and stored nowhere, so a club
 * that goes back to the old value sees the card again.
 *
 * ADDING A SUGGESTION KIND: add its key to SUGGESTION_KEYS (rules.ts),
 * then the compiler stops at the two switches below, `currentSuggestionValue`
 * and `sameSuggestionValue`, and at `settings_learned_resolved_line`.
 */
import { t } from "../i18n/t";
import { normaliseLang } from "../i18n/lang";
import { SUGGESTION_KEYS, sameVenue, type Suggestion, type SuggestionKey, type WeeklyGameState } from "./rules";

/** What the club has now, for everything a suggestion can be about. */
export interface ClubNow {
  /** The club's weekly game: `weeklyGameOf` its active activities. */
  weeklyGame: WeeklyGameState | null;
  language: string;
  benchPickMode: string;
}

export type SuggestionState = "open" | "resolved";

/** A stored suggestion as the page shows it. `current` is the club's
 *  value NOW while it is open (so `suggestionLine` words it truthfully);
 *  `now` is that value in the same form the row uses, or null when there
 *  is nothing to compare (no weekly game, no venue, no players a side). */
export type SuggestionView = Suggestion & { state: SuggestionState; now: string | null };

/** Fired on `window` by a setting on /admin/settings after it saves, so
 *  the learned-setup panel on the same page loads its state again. */
export const LEARNED_REFRESH_EVENT = "mt:learned-setup-refresh";

/**
 * The club's weekly game: the first of its ACTIVE activities, oldest
 * first. This is the choice the reading makes (run.ts calls this on
 * `where: { orgId, isActive: true }, orderBy: { createdAt: "asc" }`), so
 * the page compares against the same game the suggestion was about.
 */
export function weeklyGameOf(
  activities: ReadonlyArray<{
    dayOfWeek: number;
    time: string;
    venue: string | null;
    sport: { playersPerTeam: number | null } | null;
  }>,
): WeeklyGameState | null {
  const first = activities[0];
  return first
    ? { dayOfWeek: first.dayOfWeek, time: first.time, venue: first.venue ?? null, playersPerSide: first.sport?.playersPerTeam ?? null }
    : null;
}

function isKnownKey(key: string): key is SuggestionKey {
  return (SUGGESTION_KEYS as readonly string[]).includes(key);
}

/**
 * What the club has now for `key`, in the form `Suggestion.current` is
 * stored in (rules.ts, `planSetup`). Null: the club has nothing there.
 * Undefined: a key this build does not know (a row written by a newer
 * build), which is left as it is.
 */
export function currentSuggestionValue(key: SuggestionKey, club: ClubNow): string | null | undefined {
  const g = club.weeklyGame;
  switch (key) {
    case "weeklyGameDay":
      return g ? String(g.dayOfWeek) : null;
    case "weeklyGameTime":
      return g ? g.time : null;
    case "venue":
      return g?.venue ? g.venue : null;
    case "format":
      return g && g.playersPerSide !== null ? String(g.playersPerSide) : null;
    case "language":
      return club.language;
    case "organiserPicks":
      return club.benchPickMode;
    default: {
      const unknown: never = key;
      void unknown;
      return undefined;
    }
  }
}

/** Are two values of `key` the same, by the comparison the reading made
 *  when it decided there was a suggestion (rules.ts, `planSetup`)? */
export function sameSuggestionValue(key: SuggestionKey, a: string, b: string): boolean {
  switch (key) {
    case "venue":
      return sameVenue(a, b);
    case "weeklyGameDay":
    case "weeklyGameTime":
    case "format":
    case "language":
    case "organiserPicks":
      return a === b;
    default: {
      const unknown: never = key;
      void unknown;
      return a === b;
    }
  }
}

export function resolveSuggestion(sg: Suggestion, club: ClubNow): SuggestionView {
  const now = isKnownKey(sg.key) ? currentSuggestionValue(sg.key, club) : undefined;
  if (now === undefined) return { ...sg, state: "open", now: sg.current };
  if (now === null) return { ...sg, state: "resolved", now };
  // What the chat showed wins: a venue can read as both the old and the new one.
  if (sameSuggestionValue(sg.key, now, sg.detected)) return { ...sg, state: "resolved", now };
  if (sameSuggestionValue(sg.key, now, sg.current)) return { ...sg, current: now, state: "open", now };
  return { ...sg, state: "resolved", now };
}

export function resolveSuggestions(suggestions: readonly Suggestion[], club: ClubNow): SuggestionView[] {
  return suggestions.map((sg) => resolveSuggestion(sg, club));
}

/** The quiet line for a resolved suggestion, in `lang`: what the club has now. */
export function resolvedLine(lang: string | null | undefined, sg: SuggestionView): string {
  const s = t(lang);
  const value =
    sg.now === null
      ? null
      : sg.key === "weeklyGameDay"
        ? s.wd_weekday({ dow: Number(sg.now) })
        : sg.key === "language"
          ? s.setup_lang_name({ key: normaliseLang(sg.now) })
          : sg.now;
  return s.settings_learned_resolved_line({ key: sg.key, value });
}
