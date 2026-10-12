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
}

const CALLS = `${E2E.GEOCODE_STUB_FILE}.calls`;

export function setGeocodeStub(stub: GeocodeStub): void {
  mkdirSync(path.dirname(E2E.GEOCODE_STUB_FILE), { recursive: true });
  writeFileSync(E2E.GEOCODE_STUB_FILE, JSON.stringify(stub));
}

/** No answers (Google finds nothing) and an empty call log. */
export function clearGeocodeStub(): void {
  setGeocodeStub({});
  rmSync(CALLS, { force: true });
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
