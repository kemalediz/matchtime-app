/**
 * THE TEST SEAM FOR EVERY OUTBOUND VENUE REQUEST (2026-10-12): the Google
 * Geocoding call (geocode.ts), the one request that expands a short map
 * link (map-link.ts) and, since 2026-10-13, the two Places API (New)
 * calls behind the venue suggestions (places.ts). All of them take their
 * `fetch` from `outboundFetch()`.
 *
 * Honoured ONLY when the server was booted with MT_TEST_MODE exactly "1",
 * which nothing sets but `e2e/helpers/env.ts`. In production this returns
 * the real `fetch` whatever else the environment holds.
 *
 * Under MT_TEST_MODE=1 the real network is NEVER used, stub file or not:
 *   - with no stub file, or no entry for the request, Google "answers"
 *     ZERO_RESULTS, a short link is a 404, Places Autocomplete has no
 *     suggestions (an empty object) and Place Details is a 404;
 *   - `MT_TEST_GEOCODE_STUB_FILE` names a JSON file the e2e suite writes:
 *
 *       {
 *         "geocode": {
 *           "<address, lower case>": { "body": { ...Google's JSON... } },
 *           "place_id:<id>":         { "body": { ... } },
 *           "<address>":             { "httpStatus": 500 },
 *           "<address>":             { "delayMs": 30000, "body": { ... } }
 *         },
 *         "shortLinks": { "<https url>": { "status": 302, "location": "<url>" } },
 *         "places": {
 *           "autocomplete": { "<input, lower case>": { "body": { ...Google's JSON... } } },
 *           "details":      { "<place id>": { "body": { ...Google's JSON... } } }
 *         }
 *       }
 *
 *     `"*"` under "geocode" answers every address without an entry of its
 *     own (and under "autocomplete", every input). Every request is
 *     appended, as one JSON line, to `<file>.calls` (without the key), so
 *     a spec can assert how many calls were made and exactly what was
 *     sent. Places requests go to `<file>.places-calls` instead, a file
 *     of their own, so a spec that counts Geocoding calls is not
 *     disturbed by an organiser typing. They record the input or place
 *     id, the session token, the language, the field mask and WHETHER a
 *     key header was sent, never the key.
 */
import { appendFileSync, readFileSync } from "node:fs";

interface StubEntry {
  body?: unknown;
  httpStatus?: number;
  delayMs?: number;
}
interface StubFile {
  geocode?: Record<string, StubEntry>;
  shortLinks?: Record<string, { status?: number; location?: string; delayMs?: number }>;
  places?: { autocomplete?: Record<string, StubEntry>; details?: Record<string, StubEntry> };
}

const GEOCODE_HOST = "maps.googleapis.com";
const PLACES_HOST = "places.googleapis.com";

function readStub(file: string | undefined): StubFile {
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StubFile;
  } catch {
    return {};
  }
}

function record(file: string | undefined, call: Record<string, unknown>, suffix = "calls"): void {
  if (!file) return;
  try {
    appendFileSync(`${file}.${suffix}`, `${JSON.stringify(call)}\n`);
  } catch {
    // A spec that never created the directory simply gets no call log.
  }
}

/** Waits `ms`, or rejects the way `fetch` does when the signal aborts. */
function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Places API (New): `POST /v1/places:autocomplete` and `GET /v1/places/<id>`. */
async function placesStub(file: string | undefined, stub: StubFile, url: URL, init: RequestInit | undefined): Promise<Response> {
  const headers = new Headers(init?.headers);
  const common = { hasKey: !!headers.get("x-goog-api-key"), fieldMask: headers.get("x-goog-fieldmask") };

  if (url.pathname === "/v1/places:autocomplete") {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    } catch {
      // Recorded as an empty request.
    }
    const input = typeof body.input === "string" ? body.input : "";
    record(
      file,
      {
        kind: "autocomplete",
        method: init?.method ?? "GET",
        input,
        sessionToken: body.sessionToken ?? null,
        languageCode: body.languageCode ?? null,
        bodyKeys: Object.keys(body).sort(),
        ...common,
      },
      "places-calls",
    );
    const table = stub.places?.autocomplete ?? {};
    const entry = table[input.toLowerCase()] ?? table["*"];
    if (entry?.delayMs) await wait(entry.delayMs, init?.signal);
    return jsonResponse(entry?.body ?? {}, entry?.httpStatus ?? 200);
  }

  const placeId = decodeURIComponent(url.pathname.replace(/^\/v1\/places\//, ""));
  record(
    file,
    {
      kind: "place-details",
      method: init?.method ?? "GET",
      placeId,
      sessionToken: url.searchParams.get("sessionToken"),
      languageCode: url.searchParams.get("languageCode"),
      params: [...url.searchParams.keys()].sort(),
      ...common,
    },
    "places-calls",
  );
  const entry = stub.places?.details?.[placeId];
  if (entry?.delayMs) await wait(entry.delayMs, init?.signal);
  if (!entry) return jsonResponse({ error: { code: 404, message: "Not found", status: "NOT_FOUND" } }, 404);
  return jsonResponse(entry.body ?? {}, entry.httpStatus ?? 200);
}

function stubFetch(file: string | undefined): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const stub = readStub(file);

    if (url.hostname === GEOCODE_HOST) {
      const placeId = url.searchParams.get("place_id");
      const address = url.searchParams.get("address");
      record(file, {
        kind: "geocode",
        address,
        placeId,
        region: url.searchParams.get("region"),
        params: [...url.searchParams.keys()].sort(),
      });
      const table = stub.geocode ?? {};
      const entry = (placeId ? table[`place_id:${placeId}`] : table[(address ?? "").toLowerCase()]) ?? table["*"];
      if (entry?.delayMs) await wait(entry.delayMs, init?.signal);
      return new Response(JSON.stringify(entry?.body ?? { status: "ZERO_RESULTS", results: [] }), {
        status: entry?.httpStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.hostname === PLACES_HOST) return placesStub(file, stub, url, init);

    record(file, { kind: "short-link", url: url.href });
    const entry = stub.shortLinks?.[url.href];
    if (entry?.delayMs) await wait(entry.delayMs, init?.signal);
    if (!entry?.location) return new Response(null, { status: 404 });
    return new Response(null, { status: entry.status ?? 302, headers: { location: entry.location } });
  }) as typeof fetch;
}

/** The `fetch` every outbound venue request uses. */
export function outboundFetch(env: Record<string, string | undefined> = process.env): typeof fetch {
  if (env.MT_TEST_MODE !== "1") return fetch;
  return stubFetch(env.MT_TEST_GEOCODE_STUB_FILE || undefined);
}

/**
 * A `fetch` that sends the two short-link hosts to a server on THIS
 * machine and passes everything else (the method, `redirect: "manual"`,
 * the abort signal) to `base` untouched. For the tests that run
 * `expandShortLink` through a real `fetch` against a local hostile
 * server: plain Node's in the unit suite, Next's patched one through
 * /api/test/venue-short-link (a route that exists only under
 * MT_TEST_MODE=1).
 *
 * It can only ever point at 127.0.0.1, and any URL that is not one of
 * the two short hosts is refused rather than fetched, so it cannot be
 * turned into a way to reach anything else. `requested` receives every
 * URL the expander asked for, as the expander wrote it.
 */
export function remapShortHostsTo(port: number, base: typeof fetch, requested: string[] = []): typeof fetch {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("remapShortHostsTo: bad port");
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(asked);
    const url = new URL(asked);
    if (url.protocol !== "https:" || (url.hostname !== "maps.app.goo.gl" && url.hostname !== "goo.gl")) {
      throw new Error("remapShortHostsTo: not a short-link host");
    }
    return base(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}
