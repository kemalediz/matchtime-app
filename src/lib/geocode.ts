/**
 * THE ONE CALL TO GOOGLE'S GEOCODING API (rewritten 2026-10-12; first
 * written 2026-06-18 as an unused foundation).
 *
 * `geocode` asks Google for a place, by text (the venue words, with the
 * club's country as a region bias) or by place id (from a pasted map
 * link), and returns the top result with what is needed to judge it:
 * its types, whether Google calls it a partial match, how precise the
 * position is, and its country.
 *
 * It NEVER throws and never waits long: a timeout, a network failure, a
 * refused key, a quota error or a malformed body is an `error` outcome.
 * The caller (venue-location.ts) treats venue location as best-effort
 * enrichment that must not block or fail a save.
 *
 * WHAT IS SENT: `address` and `region`, or `place_id`, plus the key.
 * Nothing else. Never a club name, a group name, a person or a phone.
 *
 * WHAT IS LOGGED: the status. Never the words looked up, an address,
 * coordinates or the key (an error's message can carry the URL, so only
 * its name is logged).
 *
 * The key is `GOOGLE_MAPS_API_KEY`, read on the server only. Nothing in
 * this file is imported by a client component.
 */
import { outboundFetch } from "./geocode-test-seam";

/** How long Google gets before the lookup gives up. */
export const GEOCODE_TIMEOUT_MS = 2500;

const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/** Google saying "no more for now". A bulk run must stop on these. */
const QUOTA_STATUSES = new Set(["OVER_QUERY_LIMIT", "OVER_DAILY_LIMIT", "RESOURCE_EXHAUSTED"]);

export interface GeocodeHit {
  placeId: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  /** Google's result types, for example "establishment" or "locality". */
  types: string[];
  /** Google could not match the whole request and matched part of it. */
  partialMatch: boolean;
  /** ROOFTOP, RANGE_INTERPOLATED, GEOMETRIC_CENTER or APPROXIMATE. */
  locationType: string | null;
  /** ISO 3166-1 alpha-2 country of the result, when Google gives one. */
  countryCode: string | null;
}

export type GeocodeOutcome =
  | { status: "ok"; hit: GeocodeHit }
  /** Google answered and found nothing. */
  | { status: "none" }
  /** Timed out, failed, or answered something that is not a result.
   *  `code` is "quota" (rate or daily limit), "denied" (the key was
   *  refused), "timeout", "failed", or another short reason. */
  | { status: "error"; code: string }
  /** No key configured: nothing was sent. */
  | { status: "off" };

export type GeocodeRequest = { address: string; region?: string } | { placeId: string };

export interface GeocodeOptions {
  /** Defaults to `GOOGLE_MAPS_API_KEY`. */
  key?: string | null;
  timeoutMs?: number;
  /** Tests hand a stub in; otherwise `outboundFetch()` (the test seam). */
  fetchImpl?: typeof fetch;
}

/** Is a key configured? Checked before a lookup is counted against a cap. */
export function geocodingConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.GOOGLE_MAPS_API_KEY;
}

function readHit(top: unknown): GeocodeHit | null {
  const r = top as {
    place_id?: unknown;
    formatted_address?: unknown;
    geometry?: { location?: { lat?: unknown; lng?: unknown }; location_type?: unknown };
    types?: unknown;
    partial_match?: unknown;
    address_components?: Array<{ short_name?: unknown; types?: unknown }>;
  } | null;
  const lat = r?.geometry?.location?.lat;
  const lng = r?.geometry?.location?.lng;
  if (!r || typeof r.place_id !== "string" || typeof lat !== "number" || typeof lng !== "number") return null;
  const country = Array.isArray(r.address_components)
    ? r.address_components.find((c) => Array.isArray(c.types) && c.types.includes("country"))
    : undefined;
  return {
    placeId: r.place_id,
    formattedAddress: typeof r.formatted_address === "string" ? r.formatted_address : "",
    lat,
    lng,
    types: Array.isArray(r.types) ? r.types.filter((t): t is string => typeof t === "string") : [],
    partialMatch: r.partial_match === true,
    locationType: typeof r.geometry?.location_type === "string" ? r.geometry.location_type : null,
    countryCode: typeof country?.short_name === "string" ? country.short_name.toUpperCase() : null,
  };
}

export async function geocode(request: GeocodeRequest, opts: GeocodeOptions = {}): Promise<GeocodeOutcome> {
  const key = opts.key === undefined ? process.env.GOOGLE_MAPS_API_KEY : opts.key;
  if (!key) {
    console.debug("[geocode] status=off (no key)");
    return { status: "off" };
  }

  const params = new URLSearchParams();
  if ("placeId" in request) {
    params.set("place_id", request.placeId);
  } else {
    params.set("address", request.address);
    if (request.region) params.set("region", request.region);
  }
  params.set("key", key);

  const fetchImpl = opts.fetchImpl ?? outboundFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ENDPOINT}?${params.toString()}`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      console.debug(`[geocode] status=http-${res.status}`);
      const code = res.status === 429 ? "quota" : res.status === 403 ? "denied" : `http-${res.status}`;
      return { status: "error", code };
    }
    const data = (await res.json()) as { status?: unknown; results?: unknown };
    const status = typeof data?.status === "string" ? data.status : "unknown";
    if (status === "ZERO_RESULTS") {
      console.debug("[geocode] status=ZERO_RESULTS");
      return { status: "none" };
    }
    if (status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) {
      console.debug(`[geocode] status=${status.replace(/[^A-Z_a-z]/g, "").slice(0, 40)}`);
      if (QUOTA_STATUSES.has(status)) return { status: "error", code: "quota" };
      if (status === "REQUEST_DENIED") return { status: "error", code: "denied" };
      return { status: "error", code: status === "OK" ? "empty" : "google" };
    }
    const hit = readHit(data.results[0]);
    if (!hit) {
      console.debug("[geocode] status=malformed");
      return { status: "error", code: "malformed" };
    }
    console.debug("[geocode] status=OK");
    return { status: "ok", hit };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    // The name only: a fetch error's message can carry the request URL.
    console.debug(`[geocode] status=${timedOut ? "timeout" : "failed"} (${(err as Error)?.name ?? "error"})`);
    return { status: "error", code: timedOut ? "timeout" : "failed" };
  } finally {
    clearTimeout(timer);
  }
}
