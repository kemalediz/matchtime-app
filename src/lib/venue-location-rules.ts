/**
 * VENUE LOCATION, the pure rules (2026-10-12).
 *
 * MatchTime stores where each weekly game is played: a `Venue` row (a
 * place and its coordinates) linked from `Activity.venueId`. The
 * organiser's own venue TEXT (`Activity.venue`) is untouched and stays
 * what every message and page prints.
 *
 * This file decides, with no database and no network:
 *   - which country a club is probably in (the only hint sent to Google
 *     besides the venue text);
 *   - the key two lookups share when they are the same question;
 *   - how sure a match is;
 *   - what the admin page is told.
 *
 * PRIVACY. Location is stored only. Nothing here is shown to anybody
 * outside the club, and there is no "nearby" query anywhere.
 */
import type { GeocodeHit } from "./geocode";

/** Outbound lookups one club may cause per London day (Google calls, the
 *  request that expands a short link, and pasted pins). A club needs one
 *  per weekly game, plus a few corrections. */
export const VENUE_LOOKUPS_PER_CLUB_PER_DAY = 10;

/** How long a scheduled lookup may stay "pending" before the page stops
 *  saying "looking" and says it could not check (the lookup itself gives
 *  up after 2.5 seconds; this covers a server that never ran it). */
export const VENUE_PENDING_WINDOW_MS = 30_000;

/** `Activity.venueLookupStatus`. Null: never looked up. */
export type VenueLookupStatus = "pending" | "found" | "none" | "failed" | "capped";

/**
 * Every venue-location column, set to null: what an edit of the venue
 * TEXT writes alongside the new text, so a stale place never stays
 * attached to new words. The ONLY values a save ever writes to these
 * columns on a client's behalf, and they are not the client's.
 */
export const CLEARED_VENUE_LINK = {
  venueId: null,
  venueConfidence: null,
  venueMatchSource: null,
  venueLookupStatus: null,
  venueResolvedAt: null,
  venueConfirmedAt: null,
  venueConfirmedById: null,
} as const;

export type VenueConfidence = "high" | "low";
export type VenueMatchSource = "text" | "address" | "link" | "backfill";

// ── The venue text ──────────────────────────────────────────────────────

/** The combining accents of the Latin alphabets, U+0300 to U+036F. Built
 *  from code points so no invisible character sits in this file. */
const LATIN_ACCENTS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
const DOTLESS_I = new RegExp(String.fromCharCode(0x131), "g");

/**
 * Case folded, no Latin accents, no punctuation, single spaces. Letters
 * and digits of EVERY script are kept (with the marks that belong to
 * them), so two stadiums named in Cyrillic are two venues and not two
 * empty strings.
 *
 * The accents removed are the combining marks U+0300 to U+036F only
 * (after NFKD): they are what separates an accented Latin letter from
 * its plain one. Marks of other scripts (Arabic, Devanagari and so on)
 * are part of the word and stay. Turkish: the dotted capital I
 * decomposes to "I" plus a dot above, which goes; the dotless i is
 * folded to "i" by hand.
 */
export function normaliseVenueText(text: string): string {
  return (text ?? "")
    .normalize("NFKD")
    .replace(LATIN_ACCENTS, "")
    .replace(DOTLESS_I, "i")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

const PLACEHOLDERS = new Set(["", "tbd", "tba", "tbc"]);

/** "TBD" and friends: there is no place to look up. */
export function isPlaceholderVenue(text: string | null | undefined): boolean {
  return PLACEHOLDERS.has(normaliseVenueText(text ?? ""));
}

/** Country plus the normalised words: the same question asked twice. */
export function venueQueryKey(text: string, country: string | null): string {
  return `${country ?? "--"}|${normaliseVenueText(text)}`;
}

// ── The country hint ────────────────────────────────────────────────────

/**
 * Calling code to country, for codes that mean ONE country. "+1" (the
 * USA, Canada and much of the Caribbean) is left out on purpose: a hint
 * that may be wrong is worse than none.
 */
const CALLING_CODES: Array<[string, string]> = [
  ["+353", "IE"],
  ["+351", "PT"],
  ["+357", "CY"],
  ["+971", "AE"],
  ["+30", "GR"],
  ["+31", "NL"],
  ["+32", "BE"],
  ["+33", "FR"],
  ["+34", "ES"],
  ["+39", "IT"],
  ["+41", "CH"],
  ["+43", "AT"],
  ["+44", "GB"],
  ["+45", "DK"],
  ["+46", "SE"],
  ["+47", "NO"],
  ["+48", "PL"],
  ["+49", "DE"],
  ["+61", "AU"],
  ["+64", "NZ"],
  ["+90", "TR"],
];

/** The country of an E.164 phone number, or null when it cannot be told. */
export function countryFromPhone(phone: string | null | undefined): string | null {
  if (!phone || !phone.startsWith("+")) return null;
  for (const [code, country] of CALLING_CODES) if (phone.startsWith(code)) return country;
  return null;
}

/**
 * Where a club probably plays. The organiser's phone decides (a Turkish
 * speaking club run from a +44 number plays in the UK); with no usable
 * phone, a Turkish club is taken to be in Turkey, and an English one
 * gives no hint at all.
 */
export function clubCountry(input: { ownerPhone: string | null | undefined; language: string | null | undefined }): string | null {
  const fromPhone = countryFromPhone(input.ownerPhone);
  if (fromPhone) return fromPhone;
  return (input.language ?? "").toLowerCase().startsWith("tr") ? "TR" : null;
}

/** Google's `region` takes a web suffix, and the UK's is "uk", not "gb". */
export function regionForCountry(country: string): string {
  return country === "GB" ? "uk" : country.toLowerCase();
}

/**
 * Exactly what Google is sent for a text lookup: the words and, when
 * known, the region. `region` is a BIAS, not a filter: a club whose
 * country we guessed wrong still gets its place, and the result's own
 * country then marks the match low (see `classifyConfidence`).
 */
export function buildGeocodeQuery(text: string, country: string | null): { address: string; region?: string } {
  const address = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return country ? { address, region: regionForCountry(country) } : { address };
}

// ── How sure a match is ─────────────────────────────────────────────────

/** Result types that are a place you can stand on, not an area. */
const PLACE_TYPES = new Set(["establishment", "point_of_interest", "premise", "subpremise"]);

/**
 * LOW when any of these is true, HIGH otherwise:
 *   - Google calls it a partial match;
 *   - the position is approximate;
 *   - it is not a named place or a building (a town, a road, a postcode);
 *     a street address counts only when Google has the rooftop;
 *   - the words looked up were a single word ("Powerleague", "Goals"):
 *     a chain or a town, never one pitch;
 *   - it is in another country than the club's.
 */
export function classifyConfidence(input: {
  query: string;
  hit: GeocodeHit;
  expectedCountry: string | null;
}): VenueConfidence {
  const { hit } = input;
  if (hit.partialMatch) return "low";
  if (hit.locationType === "APPROXIMATE") return "low";
  const isPlace =
    hit.types.some((t) => PLACE_TYPES.has(t)) || (hit.types.includes("street_address") && hit.locationType === "ROOFTOP");
  if (!isPlace) return "low";
  if (normaliseVenueText(input.query).split(" ").filter(Boolean).length < 2) return "low";
  if (input.expectedCountry && hit.countryCode && input.expectedCountry !== hit.countryCode) return "low";
  return "high";
}

// ── What the page is told ───────────────────────────────────────────────

/** A plain Google Maps link. No embedded map, no script, no key. */
export function venueMapUrl(v: { placeId: string | null; lat: number | null; lng: number | null }): string | null {
  if (v.lat == null || v.lng == null) return null;
  const q = new URLSearchParams({ api: "1", query: `${v.lat},${v.lng}` });
  if (v.placeId) q.set("query_place_id", v.placeId);
  return `https://www.google.com/maps/search/?${q.toString()}`;
}

/**
 * What the confirm line shows. Six states an organiser can be in, told
 * apart by what was RECORDED, never inferred:
 *
 *   never    nothing was ever looked up (every game that predates this)
 *   pending  a lookup was scheduled and has not reported back yet
 *   failed   the lookup could not be made: Google failed or timed out,
 *            no key, or the club's daily lookups were used up
 *   none     Google answered and found nothing
 *   found    a place is linked: low or high confidence, confirmed or not
 */
export type VenueLocationView =
  | { state: "never" }
  | { state: "pending" }
  | { state: "failed" }
  | { state: "none" }
  | {
      state: "found";
      address: string | null;
      /** Rounded coordinates, only when there is no address to show. */
      coords: string | null;
      mapUrl: string | null;
      confidence: VenueConfidence;
      confirmed: boolean;
    };

export interface VenueLocationRow {
  venue: string;
  venueId: string | null;
  venueConfidence: string | null;
  venueLookupStatus: string | null;
  venueResolvedAt: Date | null;
  venueConfirmedAt: Date | null;
  venueRef: { placeId: string | null; formattedAddress: string | null; lat: number | null; lng: number | null } | null;
}

/** For the club's own OWNER and ADMINs only (see /api/activities). */
export function venueLocationView(row: VenueLocationRow, now: Date): VenueLocationView {
  if (row.venueId && row.venueRef) {
    const v = row.venueRef;
    return {
      state: "found",
      address: v.formattedAddress,
      coords: !v.formattedAddress && v.lat != null && v.lng != null ? `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}` : null,
      mapUrl: venueMapUrl(v),
      confidence: row.venueConfidence === "high" ? "high" : "low",
      confirmed: row.venueConfirmedAt != null,
    };
  }
  switch (row.venueLookupStatus) {
    case "pending": {
      // A scheduled lookup that never reported back is a failure, not an
      // endless "looking".
      const since = row.venueResolvedAt ? now.getTime() - row.venueResolvedAt.getTime() : Infinity;
      return since < VENUE_PENDING_WINDOW_MS ? { state: "pending" } : { state: "failed" };
    }
    case "none":
      return { state: "none" };
    case "failed":
    case "capped":
      return { state: "failed" };
    default:
      return { state: "never" };
  }
}

// ── What a member-facing response must not carry ────────────────────────

const VENUE_BOOKKEEPING = [
  "venueId",
  "venueConfidence",
  "venueMatchSource",
  "venueLookupStatus",
  "venueResolvedAt",
  "venueConfirmedAt",
  "venueConfirmedById",
] as const;

export type VenueBookkeepingKey = (typeof VENUE_BOOKKEEPING)[number];

/**
 * An activity row without the venue-location columns, for a route that
 * returns a whole `Activity` to any member (for example
 * /api/matches/:id). They hold no address or coordinates, but they are
 * the organiser's business, and one of them is who confirmed.
 */
export function withoutVenueBookkeeping<T extends object>(activity: T): Omit<T, VenueBookkeepingKey> {
  const copy = { ...activity } as Record<string, unknown>;
  for (const key of VENUE_BOOKKEEPING) delete copy[key];
  return copy as Omit<T, VenueBookkeepingKey>;
}
