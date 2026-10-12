/**
 * PASTED MAP LINKS (2026-10-12): what the organiser may paste into the
 * "Change" box under a venue, and how a place is read out of it.
 *
 * THE RULE: the server never fetches a URL an organiser pasted. A link is
 * PARSED. Coordinates, a place id or a place name that are in the URL
 * itself are read out of it; a link that carries none is refused.
 *
 * THE ONE EXCEPTION, AND WHY. The Google Maps app's Share button produces
 * `https://maps.app.goo.gl/<code>`: a short link with nothing in it. An
 * organiser arriving from WhatsApp on a phone will paste exactly that, so
 * refusing it would refuse nearly every link pasted in practice. It is
 * therefore expanded, by `expandShortLink`, under these rules:
 *
 *   1. Only two hosts are ever requested, matched as exact strings:
 *      `maps.app.goo.gl`, and `goo.gl` under `/maps/`. Both are Google's.
 *   2. The request URL is REBUILT from the checked parts: always https,
 *      never a port, never userinfo, never a fragment.
 *   3. Redirects are never followed by `fetch` (`redirect: "manual"`).
 *      The `Location` header is read and checked here.
 *   4. A `Location` on a short host is requested in turn, at most
 *      `SHORT_LINK_MAX_HOPS` requests in all. A `Location` on a Google
 *      Maps host is the answer: it is PARSED and NEVER FETCHED. A
 *      `Location` anywhere else (another site, an IP literal, plain http,
 *      a port, userinfo, a Google page that is not a map) ends it with a
 *      refusal.
 *   5. A hard timeout covers the whole expansion. No cookies or
 *      credentials are sent. The response body is never read: it is
 *      cancelled, so there is no size to cap. An over-long `Location` is
 *      refused.
 *
 * So the worst a hostile short link can do is make the server ask Google
 * for a redirect and then be told no.
 *
 * NOT SUPPORTED, and the page says so:
 *   - what3words: a what3words link holds three words, not coordinates,
 *     and turning them into a position needs their paid API;
 *   - other short links (`maps.apple/p/...`, `waze.com/ul/h...`,
 *     `osm.org/go/...`, Yandex's `/maps/-/<code>`): each would need its
 *     own host on the allow-list. Yandex Maps LONG links are read (owner
 *     decision 2026-10-12, Turkish clubs use them); its short share
 *     links are refused and Yandex is not on the outbound allow-list.
 *
 * Recognising a FULL map link is loose on purpose (any Google country
 * domain): a full link is only ever parsed, so a host that merely looks
 * like Google gains nothing but having its own query string read.
 */
import { outboundFetch } from "./geocode-test-seam";

export type MapProvider = "google" | "apple" | "waze" | "osm" | "yandex";

export type UnsupportedReason = "empty" | "unknown-host" | "no-location" | "short-link" | "what3words";

export type MapInput =
  /** Not a link: an address the organiser typed. */
  | { kind: "address"; text: string }
  | { kind: "coords"; provider: MapProvider; lat: number; lng: number; label?: string }
  | { kind: "placeId"; provider: "google"; placeId: string }
  /** A link that names a place but carries no position: look the name up. */
  | { kind: "text"; provider: MapProvider; text: string }
  /** A short Google link: nothing is known until `expandShortLink`. */
  | { kind: "short"; provider: "google"; url: URL }
  | { kind: "unsupported"; reason: UnsupportedReason };

/** A place read from a link: what a short link may expand to. */
export type MapTarget = Extract<MapInput, { kind: "coords" | "placeId" | "text" }>;

export const SHORT_LINK_MAX_HOPS = 3;
export const SHORT_LINK_TIMEOUT_MS = 3000;
const MAX_LOCATION_LENGTH = 2048;
const MAX_TEXT_LENGTH = 200;

// ── Hosts ───────────────────────────────────────────────────────────────

/** EXACT hosts the server may request. Nothing else, ever. */
function isShortHost(url: URL): boolean {
  if (url.hostname === "maps.app.goo.gl") return true;
  return url.hostname === "goo.gl" && url.pathname.startsWith("/maps/");
}

const GOOGLE_HOST = /^(?:(www|maps)\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const APPLE_HOSTS = new Set(["maps.apple.com"]);
const WAZE_HOSTS = new Set(["waze.com", "www.waze.com", "ul.waze.com"]);
const OSM_HOSTS = new Set(["openstreetmap.org", "www.openstreetmap.org"]);
const W3W_HOSTS = new Set(["what3words.com", "www.what3words.com", "w3w.co"]);
/** Yandex Maps, EXACT hosts: the three sites and their `maps.` forms. */
const YANDEX_SITE_HOSTS = new Set(["yandex.com", "yandex.com.tr", "yandex.ru"]);
const YANDEX_MAPS_HOSTS = new Set(["maps.yandex.com", "maps.yandex.com.tr", "maps.yandex.ru"]);
const OTHER_SHORT_HOSTS = new Set(["maps.apple", "osm.org", "g.co", "g.page"]);

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * The checks every URL passes before anything else looks at it: http or
 * https, a real host name (no IP literal, no trailing dot), no userinfo,
 * no port. `new URL` has already lower-cased the host, turned a decimal
 * or hex IP into dotted form, and dropped a default port.
 */
function safeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  const host = url.hostname;
  if (!host || host.endsWith(".") || !host.includes(".") || isIpLiteral(host)) return null;
  return url;
}

// ── Reading values ──────────────────────────────────────────────────────

function coords(latRaw: string, lngRaw: string): { lat: number; lng: number } | null {
  if (!/^-?\d{1,3}(\.\d+)?$/.test(latRaw) || !/^-?\d{1,3}(\.\d+)?$/.test(lngRaw)) return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** "51.5,-0.1", "loc:51.5,-0.1" or "ll.51.5,-0.1". */
function coordPair(value: string | null): { lat: number; lng: number } | null {
  if (!value) return null;
  const m = /^(?:loc:|ll\.)?\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(value.trim());
  return m ? coords(m[1], m[2]) : null;
}

/** A value that looked like coordinates but is not a usable position. */
function looksLikeCoords(value: string | null): boolean {
  return !!value && /^(?:loc:|ll\.)?\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(value.trim());
}

function cleanText(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
  return text.length >= 2 ? text : null;
}

function decodeSegment(segment: string): string | null {
  try {
    return cleanText(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

const NO_LOCATION: MapInput = { kind: "unsupported", reason: "no-location" };

// ── One parser per service ──────────────────────────────────────────────

function parseGoogle(url: URL): MapInput {
  const onMapsHost = url.hostname.startsWith("maps.");
  if (!onMapsHost && !url.pathname.startsWith("/maps")) return { kind: "unsupported", reason: "unknown-host" };

  const place = /\/maps\/place\/([^/@]+)/.exec(url.pathname);
  const placeText = place ? decodeSegment(place[1]) : null;
  const label = placeText && !looksLikeCoords(placeText) ? placeText : undefined;
  const q = url.searchParams;

  // The pin itself, then a place id, then the viewport centre.
  const pin = /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/.exec(url.pathname);
  const pinned = pin ? coords(pin[1], pin[2]) : null;
  if (pinned) return { kind: "coords", provider: "google", ...pinned, ...(label ? { label } : {}) };

  const idParam = q.get("query_place_id") ?? q.get("destination_place_id");
  const idInQ = /^place_id:(.+)$/.exec(q.get("q") ?? "")?.[1];
  const placeId = idParam ?? idInQ;
  if (placeId) {
    return /^[A-Za-z0-9_-]{10,255}$/.test(placeId) ? { kind: "placeId", provider: "google", placeId } : NO_LOCATION;
  }

  const at = /\/@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(url.pathname);
  const centre = at ? coords(at[1], at[2]) : null;
  if (centre) return { kind: "coords", provider: "google", ...centre, ...(label ? { label } : {}) };

  let sawCoords = false;
  for (const name of ["q", "query", "ll", "destination", "daddr", "center"]) {
    const value = q.get(name);
    const pair = coordPair(value);
    if (pair) return { kind: "coords", provider: "google", ...pair };
    if (looksLikeCoords(value)) sawCoords = true;
  }
  if (sawCoords) return NO_LOCATION;

  const text = label ?? cleanText(q.get("q")) ?? cleanText(q.get("query"));
  return text ? { kind: "text", provider: "google", text } : NO_LOCATION;
}

function parseApple(url: URL): MapInput {
  const q = url.searchParams;
  for (const name of ["ll", "coordinate", "sll", "center", "q"]) {
    const pair = coordPair(q.get(name));
    if (pair) return { kind: "coords", provider: "apple", ...pair };
  }
  const text = cleanText(q.get("address")) ?? cleanText(q.get("q")) ?? cleanText(q.get("name"));
  return text && !looksLikeCoords(text) ? { kind: "text", provider: "apple", text } : NO_LOCATION;
}

function parseWaze(url: URL): MapInput {
  if (/^\/ul\/h/.test(url.pathname)) return { kind: "unsupported", reason: "short-link" };
  const q = url.searchParams;
  for (const name of ["ll", "latlng", "to"]) {
    const pair = coordPair(q.get(name));
    if (pair) return { kind: "coords", provider: "waze", ...pair };
  }
  return NO_LOCATION;
}

function parseOsm(url: URL): MapInput {
  const q = url.searchParams;
  const marker = q.get("mlat") && q.get("mlon") ? coords(q.get("mlat")!, q.get("mlon")!) : null;
  if (marker) return { kind: "coords", provider: "osm", ...marker };
  const hash = /^#map=\d+(?:\.\d+)?\/(-?\d{1,3}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/.exec(url.hash);
  const centre = hash ? coords(hash[1], hash[2]) : null;
  return centre ? { kind: "coords", provider: "osm", ...centre } : NO_LOCATION;
}

/**
 * Yandex Maps. On the three sites only `/maps` and `/harita` (the Turkish
 * site's word for it) are the map; on a `maps.` host everything is.
 *
 * YANDEX WRITES LONGITUDE FIRST, THEN LATITUDE, the opposite of every
 * other service in this file. `yandexPair` is the only place that order
 * is read, and nothing is ever guessed by swapping a pair that does not
 * fit.
 *
 * The pin wins over the map centre: `pt` (a marker; it may carry a style
 * and several points, the first is used), then the "what is here" and
 * place points, then `ll` (the centre of the view).
 */
function yandexPair(value: string | null): { lat: number; lng: number } | null {
  if (!value) return null;
  const [lngRaw, latRaw] = value.split("~")[0].split(",").map((part) => part.trim());
  return lngRaw !== undefined && latRaw !== undefined ? coords(latRaw, lngRaw) : null;
}

function parseYandex(url: URL): MapInput {
  const onMapsHost = YANDEX_MAPS_HOSTS.has(url.hostname);
  const mapPath = /^\/(maps|harita)(\/|$)/.test(url.pathname);
  if (!onMapsHost && !mapPath) return { kind: "unsupported", reason: "unknown-host" };
  if (/^\/(maps|harita)\/-\//.test(url.pathname) || /^\/-\//.test(url.pathname)) return { kind: "unsupported", reason: "short-link" };
  const q = url.searchParams;
  for (const name of ["pt", "whatshere[point]", "poi[point]", "ll"]) {
    const pair = yandexPair(q.get(name));
    if (pair) return { kind: "coords", provider: "yandex", ...pair };
  }
  return NO_LOCATION;
}

/** A checked URL to what it says. Nothing is fetched. */
function parseUrl(url: URL): MapInput {
  const host = url.hostname;
  if (isShortHost(url)) return { kind: "short", provider: "google", url };
  if (W3W_HOSTS.has(host)) return { kind: "unsupported", reason: "what3words" };
  if (OTHER_SHORT_HOSTS.has(host)) return { kind: "unsupported", reason: "short-link" };
  if (GOOGLE_HOST.test(host)) return parseGoogle(url);
  if (APPLE_HOSTS.has(host)) return parseApple(url);
  if (WAZE_HOSTS.has(host)) return parseWaze(url);
  if (OSM_HOSTS.has(host)) return parseOsm(url);
  if (YANDEX_SITE_HOSTS.has(host) || YANDEX_MAPS_HOSTS.has(host)) return parseYandex(url);
  return { kind: "unsupported", reason: "unknown-host" };
}

/**
 * What the organiser put in the "Change" box: an address, or a map link
 * (alone, or inside a pasted share such as "Our pitch https://...").
 */
export function parseMapInput(raw: string): MapInput {
  const input = (raw ?? "").trim();
  if (!input) return { kind: "unsupported", reason: "empty" };

  const withScheme = /[a-z][a-z0-9+.-]*:\/\/\S+/i.exec(input)?.[0];
  // "maps.app.goo.gl/AbC" typed or pasted without its scheme.
  const bare = !withScheme && /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(input) ? `https://${input}` : null;
  // "javascript:..." and friends have no "//" but are not an address either.
  const otherScheme = !withScheme && !bare && /^[a-z][a-z0-9+.-]*:\S*$/i.test(input);
  if (otherScheme) return { kind: "unsupported", reason: "unknown-host" };

  const candidate = withScheme ?? bare;
  if (!candidate) return { kind: "address", text: input.replace(/\s+/g, " ").slice(0, MAX_TEXT_LENGTH) };

  const url = safeUrl(candidate);
  if (!url) return { kind: "unsupported", reason: "unknown-host" };
  return parseUrl(url);
}

// ── The one request ─────────────────────────────────────────────────────

export type ShortLinkResult =
  | { ok: true; target: MapTarget }
  | { ok: false; reason: "left-allow-list" | "no-redirect" | "too-many-hops" | "timeout" | "failed" | "no-location" };

/**
 * Follow a short Google link to the map link behind it, by hand, under
 * the rules at the top of this file. Never throws.
 */
export async function expandShortLink(
  start: URL,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ShortLinkResult> {
  const fetchImpl = opts.fetchImpl ?? outboundFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SHORT_LINK_TIMEOUT_MS);

  try {
    let current: URL | null = safeUrl(start.href);
    for (let hop = 0; hop < SHORT_LINK_MAX_HOPS; hop++) {
      if (!current || !isShortHost(current)) return { ok: false, reason: "left-allow-list" };
      // Rebuilt from the checked parts: https, host, path and query only.
      const requestUrl = `https://${current.hostname}${current.pathname}${current.search}`;

      const res = await fetchImpl(requestUrl, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
        headers: { accept: "text/html" },
      });
      // The body is never read, whatever came back.
      await res.body?.cancel().catch(() => undefined);

      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || !location) return { ok: false, reason: "no-redirect" };
      if (location.length > MAX_LOCATION_LENGTH) return { ok: false, reason: "left-allow-list" };

      let resolved: string;
      try {
        resolved = new URL(location, requestUrl).href;
      } catch {
        return { ok: false, reason: "left-allow-list" };
      }
      const next = safeUrl(resolved);
      if (!next || next.protocol !== "https:") return { ok: false, reason: "left-allow-list" };

      if (isShortHost(next)) {
        current = next;
        continue;
      }
      // A full map link is the answer. It is parsed, never fetched.
      if (!GOOGLE_HOST.test(next.hostname)) return { ok: false, reason: "left-allow-list" };
      const target = parseGoogle(next);
      if (target.kind === "coords" || target.kind === "placeId" || target.kind === "text") return { ok: true, target };
      return { ok: false, reason: target.kind === "unsupported" && target.reason === "no-location" ? "no-location" : "left-allow-list" };
    }
    return { ok: false, reason: "too-many-hops" };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "failed" };
  } finally {
    clearTimeout(timer);
  }
}
