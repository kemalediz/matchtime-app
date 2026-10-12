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

/** How long the page calls a just-saved, not yet looked up venue "pending". */
export const VENUE_PENDING_WINDOW_MS = 20_000;

export type VenueConfidence = "high" | "low";
export type VenueMatchSource = "text" | "address" | "link" | "backfill";

// ── The venue text ──────────────────────────────────────────────────────

/** Lower case, no accents, no punctuation, single spaces. */
export function normaliseVenueText(text: string): string {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
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

export type VenueLocationView =
  | { state: "none" }
  | { state: "pending" }
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
  venueResolvedAt: Date | null;
  venueConfirmedAt: Date | null;
  updatedAt: Date;
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
  const justSaved = now.getTime() - row.updatedAt.getTime() < VENUE_PENDING_WINDOW_MS;
  if (!row.venueResolvedAt && justSaved && !isPlaceholderVenue(row.venue)) return { state: "pending" };
  return { state: "none" };
}

// ── What a member-facing response must not carry ────────────────────────

const VENUE_BOOKKEEPING = [
  "venueId",
  "venueConfidence",
  "venueMatchSource",
  "venueQueryKey",
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
