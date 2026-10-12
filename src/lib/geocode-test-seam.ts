/**
 * THE TEST SEAM FOR EVERY OUTBOUND VENUE REQUEST (2026-10-12): the Google
 * Geocoding call (geocode.ts) and the one request that expands a short
 * map link (map-link.ts). Both take their `fetch` from `outboundFetch()`.
 *
 * Honoured ONLY when the server was booted with MT_TEST_MODE exactly "1",
 * which nothing sets but `e2e/helpers/env.ts`. In production this returns
 * the real `fetch` whatever else the environment holds.
 *
 * Under MT_TEST_MODE=1 the real network is NEVER used, stub file or not:
 *   - with no stub file, or no entry for the request, Google "answers"
 *     ZERO_RESULTS and a short link is a 404;
 *   - `MT_TEST_GEOCODE_STUB_FILE` names a JSON file the e2e suite writes:
 *
 *       {
 *         "geocode": {
 *           "<address, lower case>": { "body": { ...Google's JSON... } },
 *           "place_id:<id>":         { "body": { ... } },
 *           "<address>":             { "httpStatus": 500 },
 *           "<address>":             { "delayMs": 30000, "body": { ... } }
 *         },
 *         "shortLinks": { "<https url>": { "status": 302, "location": "<url>" } }
 *       }
 *
 *     `"*"` under "geocode" answers every address without an entry of its
 *     own. Every request is appended, as one JSON line, to `<file>.calls`
 *     (without the key), so a spec can assert how many calls were made
 *     and exactly what was sent.
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
}

const GEOCODE_HOST = "maps.googleapis.com";

function readStub(file: string | undefined): StubFile {
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StubFile;
  } catch {
    return {};
  }
}

function record(file: string | undefined, call: Record<string, unknown>): void {
  if (!file) return;
  try {
    appendFileSync(`${file}.calls`, `${JSON.stringify(call)}\n`);
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
