/**
 * VENUE SUGGESTIONS, the pure rules (2026-10-13).
 *
 * As the organiser types a venue, the box shows a short list of real
 * places from Google. Picking one stores that exact place; typing on is
 * always allowed. Suggestions are a helper, never a gate: every rule here
 * falls towards "it is a plain text box".
 *
 * No database, no network and nothing server-only: the browser's box
 * (components/venue/venue-suggest-input.tsx) and the server (the route,
 * the save actions) share these rules.
 *
 * NEVER TRUST THE BROWSER FOR A LOCATION. The only things a browser can
 * hand the server about a pick are Google's place id and the session
 * token the suggestions were asked with (`parseVenuePick`). The server
 * asks Google what that place is (src/lib/places.ts); no name, address,
 * position or confidence is ever read from a request.
 */
import { normaliseLang, type Lang } from "./i18n/lang";

/** Characters typed before the first suggestion call. */
export const VENUE_SUGGEST_MIN_CHARS = 3;
/** Suggestions shown, at most. */
export const VENUE_SUGGEST_MAX = 5;
/** How long the box waits after the last keystroke before asking. */
export const VENUE_SUGGEST_DEBOUNCE_MS = 300;
/** Suggestion calls one signed-in person may cause in one clock hour. A
 *  venue takes a handful; 120 is far above honest use and well below
 *  what would cost anything to notice. */
export const VENUE_SUGGEST_CALLS_PER_USER_PER_HOUR = 120;
/** The longest text sent on to Google (a venue is at most 120 characters). */
export const VENUE_SUGGEST_MAX_QUERY = 120;

/** A pasted map link (the Change box takes those): nothing to suggest. */
const LINK_LIKE = /^(https?:\/\/|www\.)|^[a-z0-9-]+(\.[a-z0-9-]+)+\//i;

/** Should the box ask for suggestions for this text at all? */
export function shouldSuggest(text: string): boolean {
  const trimmed = (text ?? "").trim();
  return trimmed.length >= VENUE_SUGGEST_MIN_CHARS && !LINK_LIKE.test(trimmed);
}

/** The text as it is sent to Google, or null when nothing should be sent. */
export function suggestQuery(raw: unknown): string | null {
  if (typeof raw !== "string" || !shouldSuggest(raw)) return null;
  return raw.replace(/\s+/g, " ").trim().slice(0, VENUE_SUGGEST_MAX_QUERY);
}

/** Google: a URL-safe string of at most 36 characters (a UUID fits). */
export function validSessionToken(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{1,36}$/.test(raw);
}

/** A place id is URL-safe characters only. It goes into a request PATH,
 *  so anything that could add a segment, a query or a fragment is refused. */
export function validPlaceId(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{10,300}$/.test(raw);
}

/** The language suggestions are asked for in: one MatchTime speaks. */
export function suggestLanguage(raw: unknown): Lang {
  return normaliseLang(typeof raw === "string" ? raw : null);
}

/** What the server keeps of a pick. Nothing else is ever read from one. */
export interface VenuePick {
  placeId: string;
  /** The suggestions' session token, so Google bills the lookup of the
   *  place as part of the same session. Null: none usable was sent. */
  sessionToken: string | null;
}

/**
 * A pick as it arrives from a browser, reduced to the two fields above.
 * Null unless the place id is usable. A bad session token does not lose
 * the pick: it only loses the session billing.
 */
export function parseVenuePick(raw: unknown): VenuePick | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const sent = raw as Record<string, unknown>;
  if (!validPlaceId(sent.placeId)) return null;
  return { placeId: sent.placeId, sessionToken: validSessionToken(sent.sessionToken) ? sent.sessionToken : null };
}

/** What the box remembers after a suggestion is picked. */
export interface VenuePickState {
  placeId: string;
  sessionToken: string;
  /** The text the pick put in the box. */
  text: string;
}

/**
 * EDITED AFTER THE PICK = NO PICK. The pick is sent with a save only
 * while the box still holds exactly the text the pick put there. One
 * character different and it is free text again, looked up like any
 * other typed venue.
 */
export function pickForSubmit(pick: VenuePickState | null | undefined, text: string): { placeId: string; sessionToken: string } | null {
  if (!pick || pick.text !== text) return null;
  return { placeId: pick.placeId, sessionToken: pick.sessionToken };
}

/** The top of the clock hour (UTC) a call falls in: the cap's window. */
export function suggestWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
}

/** One suggestion, as the route answers it and the box shows it. */
export interface VenueSuggestion {
  placeId: string;
  /** The place's name, for example "Powerleague Croydon". */
  primary: string;
  /** Where it is, for example "Purley Way, Croydon, UK". May be empty. */
  secondary: string;
}
