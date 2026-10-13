/**
 * THE TWO CALLS TO GOOGLE'S PLACES API (NEW) (2026-10-13).
 *
 *   placesAutocomplete   while the organiser types a venue: a short list
 *                        of places. Called only by /api/venue/suggest.
 *   placeDetails         for the ONE place they picked: its name, address
 *                        and position. Called only by the server, after a
 *                        save (src/lib/venue-location.ts). The position
 *                        of a place is never taken from a browser.
 *
 * Both NEVER throw and never wait long: a timeout, a network failure, a
 * refused key, an API that is not enabled, a quota error or a malformed
 * body is an `error` outcome, and every caller then behaves as if there
 * were no suggestions at all. Sign-up and saving never depend on this.
 *
 * WHAT IS SENT. Autocomplete: the typed text, a session token and a
 * language. Details: a place id, the same session token (so Google bills
 * the whole exchange as one session) and a language. The key travels in
 * the `X-Goog-Api-Key` header, never in a URL. No country restriction:
 * clubs play in the UK and in Turkey. Never a club, a person or a phone.
 *
 * WHAT IS LOGGED: a status or a reason code. Never the typed text, a
 * place name, an address, a place id, a URL, a token or the key (an
 * error's message can carry the URL, so only its name is logged).
 *
 * The key is `GOOGLE_MAPS_API_KEY`, read on the server only. Nothing in
 * this file is imported by a client component, and no Google script or
 * key ever reaches a browser.
 */
import { outboundFetch } from "./geocode-test-seam";
import { VENUE_SUGGEST_MAX, validPlaceId, validSessionToken, type VenueSuggestion } from "./venue-suggest-rules";

/** How long Google gets before a call gives up. */
export const PLACES_TIMEOUT_MS = 2500;

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places/";

/** Only what the list shows. */
const AUTOCOMPLETE_FIELDS =
  "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text";
/** Only what is stored. Nothing else is asked for, so nothing else is billed. */
const DETAILS_FIELDS = "id,displayName,formattedAddress,location";

export interface PlacesOptions {
  /** Defaults to `GOOGLE_MAPS_API_KEY`. */
  key?: string | null;
  timeoutMs?: number;
  /** Tests hand a stub in; otherwise `outboundFetch()` (the test seam). */
  fetchImpl?: typeof fetch;
}

export type PlacesError = {
  status: "error";
  /** "quota", "denied" (the key was refused or the API is not enabled),
   *  "timeout", "failed", "malformed" or "http-<status>". */
  code: string;
};

export type AutocompleteOutcome =
  | { status: "ok"; suggestions: VenueSuggestion[] }
  | PlacesError
  /** No key configured: nothing was sent. */
  | { status: "off" };

export interface PlaceDetails {
  placeId: string;
  name: string;
  formattedAddress: string;
  lat: number;
  lng: number;
}

export type PlaceDetailsOutcome =
  | { status: "ok"; place: PlaceDetails }
  /** Google does not know this place id (or it is not one). */
  | { status: "none" }
  | PlacesError
  | { status: "off" };

/** Is a key configured? Checked before a call is counted against a cap. */
export function placesConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.GOOGLE_MAPS_API_KEY;
}

function keyFrom(opts: PlacesOptions): string | null {
  return (opts.key === undefined ? process.env.GOOGLE_MAPS_API_KEY : opts.key) || null;
}

function httpError(status: number): PlacesError {
  return { status: "error", code: status === 429 ? "quota" : status === 403 || status === 401 ? "denied" : `http-${status}` };
}

/**
 * One request, with the timeout, answering the parsed JSON body or an
 * error outcome. `what` only labels the log line.
 */
async function ask(
  what: "autocomplete" | "details",
  url: string,
  init: RequestInit,
  opts: PlacesOptions,
): Promise<{ ok: true; body: unknown } | { ok: false; httpStatus: number | null; error: PlacesError }> {
  const fetchImpl = opts.fetchImpl ?? outboundFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PLACES_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      console.debug(`[places] ${what} status=http-${res.status}`);
      return { ok: false, httpStatus: res.status, error: httpError(res.status) };
    }
    return { ok: true, body: (await res.json()) as unknown };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    // The name only: a fetch error's message can carry the request URL.
    console.debug(`[places] ${what} status=${timedOut ? "timeout" : "failed"} (${(err as Error)?.name ?? "error"})`);
    return { ok: false, httpStatus: null, error: { status: "error", code: timedOut ? "timeout" : "failed" } };
  } finally {
    clearTimeout(timer);
  }
}

const textOf = (v: unknown): string => {
  const t = (v as { text?: unknown } | null | undefined)?.text;
  return typeof t === "string" ? t.trim() : "";
};

function readSuggestion(raw: unknown): VenueSuggestion | null {
  const p = (raw as { placePrediction?: { placeId?: unknown; text?: unknown; structuredFormat?: { mainText?: unknown; secondaryText?: unknown } } } | null)
    ?.placePrediction;
  if (!p || !validPlaceId(p.placeId)) return null;
  const primary = textOf(p.structuredFormat?.mainText) || textOf(p.text);
  if (!primary) return null;
  return { placeId: p.placeId, primary, secondary: textOf(p.structuredFormat?.secondaryText) };
}

export async function placesAutocomplete(
  request: { input: string; sessionToken: string; languageCode: string },
  opts: PlacesOptions = {},
): Promise<AutocompleteOutcome> {
  const key = keyFrom(opts);
  if (!key) {
    console.debug("[places] autocomplete status=off (no key)");
    return { status: "off" };
  }
  const got = await ask(
    "autocomplete",
    AUTOCOMPLETE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": AUTOCOMPLETE_FIELDS },
      body: JSON.stringify({ input: request.input, sessionToken: request.sessionToken, languageCode: request.languageCode }),
    },
    opts,
  );
  if (!got.ok) return got.error;

  // No suggestions is an empty object, not an error.
  const list = (got.body as { suggestions?: unknown } | null)?.suggestions;
  const suggestions: VenueSuggestion[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = readSuggestion(raw);
    if (s) suggestions.push(s);
    if (suggestions.length === VENUE_SUGGEST_MAX) break;
  }
  console.debug(`[places] autocomplete status=ok count=${suggestions.length}`);
  return { status: "ok", suggestions };
}

function readPlace(body: unknown): PlaceDetails | null {
  const r = body as {
    id?: unknown;
    displayName?: unknown;
    formattedAddress?: unknown;
    location?: { latitude?: unknown; longitude?: unknown };
  } | null;
  const lat = r?.location?.latitude;
  const lng = r?.location?.longitude;
  if (!r || !validPlaceId(r.id) || typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    placeId: r.id,
    name: textOf(r.displayName),
    formattedAddress: typeof r.formattedAddress === "string" ? r.formattedAddress : "",
    lat,
    lng,
  };
}

export async function placeDetails(
  request: { placeId: string; sessionToken: string | null; languageCode: string },
  opts: PlacesOptions = {},
): Promise<PlaceDetailsOutcome> {
  const key = keyFrom(opts);
  if (!key) {
    console.debug("[places] details status=off (no key)");
    return { status: "off" };
  }
  // The id goes into the PATH: only one that cannot change the path is sent.
  if (!validPlaceId(request.placeId)) {
    console.debug("[places] details status=bad-id");
    return { status: "none" };
  }
  const params = new URLSearchParams();
  if (validSessionToken(request.sessionToken)) params.set("sessionToken", request.sessionToken);
  params.set("languageCode", request.languageCode);

  const got = await ask(
    "details",
    `${DETAILS_URL}${request.placeId}?${params.toString()}`,
    { method: "GET", headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAILS_FIELDS } },
    opts,
  );
  if (!got.ok) return got.httpStatus === 404 || got.httpStatus === 400 ? { status: "none" } : got.error;

  const place = readPlace(got.body);
  if (!place) {
    console.debug("[places] details status=malformed");
    return { status: "error", code: "malformed" };
  }
  console.debug("[places] details status=ok");
  return { status: "ok", place };
}
