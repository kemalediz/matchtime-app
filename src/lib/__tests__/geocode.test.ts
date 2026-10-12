/**
 * `geocode` in src/lib/geocode.ts: the one call MatchTime makes to
 * Google's Geocoding API. What it sends, what it reads back, and that
 * no failure of Google's ever becomes an exception or a long wait.
 *
 * `fetch` is always a stub. No test in this file touches the network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { geocode } from "@/lib/geocode";
import { outboundFetch } from "@/lib/geocode-test-seam";

const ok = (over: Record<string, unknown> = {}) => ({
  status: "OK",
  results: [
    {
      place_id: "PID_123",
      formatted_address: "1 Pitch Rd, London E1 6GJ, UK",
      geometry: { location: { lat: 51.5, lng: -0.1 }, location_type: "ROOFTOP" },
      types: ["establishment", "point_of_interest"],
      address_components: [
        { short_name: "London", types: ["postal_town"] },
        { short_name: "GB", types: ["country", "political"] },
      ],
      ...over,
    },
  ],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("geocode", () => {
  it("with no key it is off: nothing is fetched", async () => {
    const fetchImpl = vi.fn();
    expect(await geocode({ address: "Powerleague" }, { key: "", fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      status: "off",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the address, the region and the key, and nothing else", async () => {
    const fetchImpl = vi.fn(async () => json(ok()));
    await geocode(
      { address: "Powerleague Shoreditch", region: "uk" },
      { key: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://maps.googleapis.com/maps/api/geocode/json");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      address: "Powerleague Shoreditch",
      region: "uk",
      key: "test-key",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a place id lookup sends the place id only", async () => {
    const fetchImpl = vi.fn(async () => json(ok()));
    await geocode({ placeId: "ChIJ_abc" }, { key: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const u = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(Object.fromEntries(u.searchParams)).toEqual({ place_id: "ChIJ_abc", key: "k" });
  });

  it("reads the top result: place, position, what kind of thing it is, the country", async () => {
    const fetchImpl = vi.fn(async () => json(ok({ partial_match: true })));
    const got = await geocode({ address: "x y" }, { key: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({
      status: "ok",
      hit: {
        placeId: "PID_123",
        formattedAddress: "1 Pitch Rd, London E1 6GJ, UK",
        lat: 51.5,
        lng: -0.1,
        types: ["establishment", "point_of_interest"],
        partialMatch: true,
        locationType: "ROOFTOP",
        countryCode: "GB",
      },
    });
  });

  it("ZERO_RESULTS is 'none', not an error", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "ZERO_RESULTS", results: [] }));
    expect(await geocode({ address: "zzz" }, { key: "k", fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      status: "none",
    });
  });

  it.each([
    ["Google refuses the key", () => json({ status: "REQUEST_DENIED", error_message: "no" })],
    ["Google is over quota", () => json({ status: "OVER_QUERY_LIMIT" })],
    ["a 500", () => json({ nope: true }, 500)],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a result with no coordinates", () => json({ status: "OK", results: [{ place_id: "x" }] })],
  ])("%s: an error outcome, never a throw", async (_name, respond) => {
    const fetchImpl = vi.fn(async () => respond());
    const got = await geocode({ address: "x" }, { key: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got.status).toBe("error");
  });

  it("the network failing is an error outcome, never a throw", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await geocode({ address: "x" }, { key: "k", fetchImpl: fetchImpl as unknown as typeof fetch })).status).toBe("error");
  });

  it("a slow Google is cut off by the timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const started = Date.now();
    const got = await geocode({ address: "x" }, { key: "k", timeoutMs: 50, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(got).toEqual({ status: "error", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("logs the status only: never the words looked up, the address or the key", async () => {
    const lines: string[] = [];
    for (const m of ["debug", "log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    }
    const k = "SECRET-KEY-123";
    await geocode({ address: "Secret Pitch Lane" }, { key: k, fetchImpl: (async () => json(ok())) as unknown as typeof fetch });
    await geocode(
      { address: "Secret Pitch Lane" },
      { key: k, fetchImpl: (async () => json({ status: "ZERO_RESULTS" })) as unknown as typeof fetch },
    );
    await geocode(
      { address: "Secret Pitch Lane" },
      {
        key: k,
        fetchImpl: (async () => {
          throw new Error(`boom https://maps.googleapis.com/?address=Secret+Pitch+Lane&key=${k}`);
        }) as unknown as typeof fetch,
      },
    );
    const all = lines.join("\n");
    expect(all).toContain("[geocode]");
    expect(all).not.toMatch(/Secret|Pitch Rd|SECRET-KEY/);
  });
});

describe("a quota or refused-key answer has its own code, so a bulk run can stop", () => {
  it.each([
    ["OVER_QUERY_LIMIT", () => json({ status: "OVER_QUERY_LIMIT" }), "quota"],
    ["OVER_DAILY_LIMIT", () => json({ status: "OVER_DAILY_LIMIT" }), "quota"],
    ["RESOURCE_EXHAUSTED", () => json({ status: "RESOURCE_EXHAUSTED" }), "quota"],
    ["HTTP 429", () => json({}, 429), "quota"],
    ["REQUEST_DENIED", () => json({ status: "REQUEST_DENIED" }), "denied"],
    ["HTTP 403", () => json({}, 403), "denied"],
    ["INVALID_REQUEST", () => json({ status: "INVALID_REQUEST" }), "google"],
  ])("%s", async (_name, respond, code) => {
    const got = await geocode({ address: "x" }, { key: "k", fetchImpl: (async () => respond()) as unknown as typeof fetch });
    expect(got).toEqual({ status: "error", code });
  });
});

describe("the test seam", () => {
  it("is the real fetch unless MT_TEST_MODE is exactly 1", () => {
    expect(outboundFetch({})).toBe(fetch);
    expect(outboundFetch({ MT_TEST_MODE: "true", MT_TEST_GEOCODE_STUB_FILE: "/tmp/x.json" })).toBe(fetch);
    expect(outboundFetch({ MT_TEST_MODE: "0" })).toBe(fetch);
  });

  it("under MT_TEST_MODE=1 it is never the real fetch, with or without a stub file", async () => {
    const real = vi.spyOn(globalThis, "fetch");
    const stub = outboundFetch({ MT_TEST_MODE: "1" });
    expect(stub).not.toBe(fetch);
    const res = await stub("https://maps.googleapis.com/maps/api/geocode/json?address=anything&key=k");
    expect(await res.json()).toMatchObject({ status: "ZERO_RESULTS" });
    const short = await stub("https://maps.app.goo.gl/abc", { redirect: "manual" });
    expect(short.status).toBe(404);
    expect(real).not.toHaveBeenCalled();
  });
});
