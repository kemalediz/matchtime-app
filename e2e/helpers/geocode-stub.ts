/**
 * The GEOCODE stub (venue location, 2026-10-12): what "Google" answers
 * the server under test, and what the server asked it.
 *
 * The server reads `E2E.GEOCODE_STUB_FILE` through
 * `src/lib/geocode-test-seam.ts`. Under MT_TEST_MODE=1 that seam never
 * uses the real network: a venue text with no entry here gets Google's
 * "ZERO_RESULTS", and a short map link with no entry is a 404.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { E2E } from "./env";

export interface GeocodeStubEntry {
  /** Google's JSON body. Omitted: ZERO_RESULTS. */
  body?: unknown;
  httpStatus?: number;
  /** Hold the answer back this long (the server's own timeout is 2.5s). */
  delayMs?: number;
}

export interface GeocodeStub {
  /** Lower-cased address, `place_id:<id>`, or `*` for every other address. */
  geocode?: Record<string, GeocodeStubEntry>;
  /** The exact https URL the server requests, to where it "redirects". */
  shortLinks?: Record<string, { status?: number; location: string }>;
  /** Places API (New), behind the venue suggestions (2026-10-13). */
  places?: {
    /** Lower-cased input, or `*` for every other input. Omitted: no suggestions. */
    autocomplete?: Record<string, GeocodeStubEntry>;
    /** By place id. Omitted: Google's 404. */
    details?: Record<string, GeocodeStubEntry>;
  };
}

const CALLS = `${E2E.GEOCODE_STUB_FILE}.calls`;
const PLACES_CALLS = `${E2E.GEOCODE_STUB_FILE}.places-calls`;

export function setGeocodeStub(stub: GeocodeStub): void {
  mkdirSync(path.dirname(E2E.GEOCODE_STUB_FILE), { recursive: true });
  writeFileSync(E2E.GEOCODE_STUB_FILE, JSON.stringify(stub));
}

/** No answers (Google finds nothing) and an empty call log. */
export function clearGeocodeStub(): void {
  setGeocodeStub({});
  rmSync(CALLS, { force: true });
  rmSync(PLACES_CALLS, { force: true });
}

export interface PlacesCall {
  kind: "autocomplete" | "place-details";
  method: string;
  input?: string;
  placeId?: string;
  sessionToken: string | null;
  languageCode: string | null;
  /** Autocomplete: the names of every field in the JSON body, sorted. */
  bodyKeys?: string[];
  /** Place Details: the names of every query parameter, sorted. */
  params?: string[];
  /** Whether a key header was sent. The key itself is never recorded. */
  hasKey: boolean;
  fieldMask: string | null;
}

/** Every Places request the server has made since the last clear. */
export function placesCalls(): PlacesCall[] {
  if (!existsSync(PLACES_CALLS)) return [];
  return readFileSync(PLACES_CALLS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PlacesCall);
}

/** Places Autocomplete's answer, shaped as the API (New) returns it. */
export function placesSuggestions(list: Array<{ placeId: string; main: string; secondary?: string }>): { suggestions: unknown[] } {
  return {
    suggestions: list.map((s) => ({
      placePrediction: {
        place: `places/${s.placeId}`,
        placeId: s.placeId,
        text: { text: s.secondary ? `${s.main}, ${s.secondary}` : s.main, matches: [{ endOffset: 3 }] },
        structuredFormat: {
          mainText: { text: s.main, matches: [{ endOffset: 3 }] },
          ...(s.secondary ? { secondaryText: { text: s.secondary } } : {}),
        },
        types: ["sports_complex", "establishment", "point_of_interest"],
      },
    })),
  };
}

/** Place Details' answer for the four fields the server asks for. */
export function placeDetailsBody(p: { placeId: string; name: string; address: string; lat: number; lng: number }): Record<string, unknown> {
  return {
    id: p.placeId,
    displayName: { text: p.name, languageCode: "en" },
    formattedAddress: p.address,
    location: { latitude: p.lat, longitude: p.lng },
  };
}

export interface GeocodeCall {
  kind: "geocode" | "short-link";
  address?: string | null;
  placeId?: string | null;
  region?: string | null;
  /** The names of every query parameter that was sent, sorted. */
  params?: string[];
  url?: string;
}

/** Every outbound venue request the server has made since the last clear. */
export function geocodeCalls(): GeocodeCall[] {
  if (!existsSync(CALLS)) return [];
  return readFileSync(CALLS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GeocodeCall);
}

/** One Google Geocoding result, shaped as the API returns it. */
export function googlePlace(over: {
  placeId: string;
  address: string;
  lat?: number;
  lng?: number;
  types?: string[];
  locationType?: string;
  partialMatch?: boolean;
  country?: string;
}): { status: "OK"; results: unknown[] } {
  return {
    status: "OK",
    results: [
      {
        place_id: over.placeId,
        formatted_address: over.address,
        geometry: {
          location: { lat: over.lat ?? 51.5229, lng: over.lng ?? -0.0757 },
          location_type: over.locationType ?? "GEOMETRIC_CENTER",
        },
        types: over.types ?? ["establishment", "point_of_interest"],
        ...(over.partialMatch ? { partial_match: true } : {}),
        address_components: [{ short_name: over.country ?? "GB", long_name: "country", types: ["country", "political"] }],
      },
    ],
  };
}
