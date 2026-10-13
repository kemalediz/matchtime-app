/**
 * GET /api/venue/suggest: the server-side proxy behind the venue box.
 *
 * Signed-in only. It answers `{ suggestions: [...] }`, at most five, each
 * `{ placeId, primary, secondary }`, and an EMPTY list for everything
 * that goes wrong (too short, over the cap, Google down, slow or
 * refusing): the box then behaves as a plain text box. It never answers
 * with an error a form could trip over.
 *
 * Auth, the cap's storage and `fetch` are stubs. No database, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  userId: "user-a" as string | null,
  allowed: true,
  claimThrows: false,
  claims: [] as string[],
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => (m.userId ? { user: { id: m.userId } } : null) }));
vi.mock("@/lib/venue-suggest-cap", () => ({
  claimSuggestCall: async (userId: string) => {
    m.claims.push(userId);
    if (m.claimThrows) throw new Error("connection refused");
    return m.allowed;
  },
}));
vi.mock("@/lib/geocode-test-seam", () => ({ outboundFetch: () => m.fetch }));

import { GET } from "@/app/api/venue/suggest/route";

const TOKEN = "3f2c1d7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const prediction = (placeId: string, main: string, secondary: string) => ({
  placePrediction: {
    placeId,
    text: { text: `${main}, ${secondary}` },
    structuredFormat: { mainText: { text: main }, secondaryText: { text: secondary } },
    types: ["establishment"],
    distanceMeters: 1200,
  },
});

const GOOGLE = {
  suggestions: Array.from({ length: 7 }, (_, i) => prediction(`ChIJ_place_number_${i}`, `Powerleague ${i}`, `Town ${i}, UK`)),
};

function call(params: Record<string, string>) {
  return GET(new Request(`https://matchtime.test/api/venue/suggest?${new URLSearchParams(params).toString()}`));
}

let lines: string[] = [];

beforeEach(() => {
  m.userId = "user-a";
  m.allowed = true;
  m.claimThrows = false;
  m.claims.length = 0;
  m.fetch.mockReset();
  m.fetch.mockImplementation(async () => json(GOOGLE));
  process.env.GOOGLE_MAPS_API_KEY = "unit-test-key";
  lines = [];
  for (const level of ["debug", "log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_MAPS_API_KEY;
});

describe("GET /api/venue/suggest", () => {
  it("signed out: 401, an empty list, and nothing is counted or sent", async () => {
    m.userId = null;
    const res = await call({ q: "Powerleague Croy", session: TOKEN });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(m.claims).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("answers at most five suggestions, each exactly placeId, primary and secondary", async () => {
    const res = await call({ q: "Powerleague Croy", session: TOKEN, lang: "en" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { suggestions: Array<Record<string, unknown>> };
    expect(body).toEqual({
      suggestions: [0, 1, 2, 3, 4].map((i) => ({ placeId: `ChIJ_place_number_${i}`, primary: `Powerleague ${i}`, secondary: `Town ${i}, UK` })),
    });
    expect(m.claims).toEqual(["user-a"]);
  });

  it("sends Google the typed text, the browser's session token and the language, and no country", async () => {
    await call({ q: "  Halı   saha Kadıköy ", session: TOKEN, lang: "tr" });
    expect(m.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = m.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect(JSON.parse(init.body as string)).toEqual({ input: "Halı saha Kadıköy", sessionToken: TOKEN, languageCode: "tr" });
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("unit-test-key");
  });

  it("a language MatchTime does not speak is asked for in English", async () => {
    await call({ q: "Powerleague", session: TOKEN, lang: "xx&regionCode=US" });
    expect(JSON.parse((m.fetch.mock.calls[0] as [string, RequestInit])[1].body as string).languageCode).toBe("en");
  });

  it.each([
    ["two characters", { q: "Po", session: TOKEN }],
    ["nothing typed", { session: TOKEN }],
    ["a pasted link", { q: "https://maps.app.goo.gl/abc", session: TOKEN }],
    ["no session token", { q: "Powerleague" }],
    ["a session token that is not one", { q: "Powerleague", session: "not a token!" }],
  ])("%s: an empty list, nothing counted against the cap, nothing sent", async (_label, params) => {
    const res = await call(params as Record<string, string>);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(m.claims).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("OVER THE CAP: an empty list and Google is not called", async () => {
    m.allowed = false;
    const res = await call({ q: "Powerleague Croy", session: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(m.claims).toEqual(["user-a"]);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("no key configured: an empty list, and the cap is not charged for a call that cannot be made", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const res = await call({ q: "Powerleague Croy", session: TOKEN });
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(m.claims).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["Places API not enabled (403)", async () => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "not enabled" } }, 403)],
    ["quota (429)", async () => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, 429)],
    ["a server error", async () => json({ error: {} }, 500)],
    ["a body that is not JSON", async () => new Response("<html>oops</html>", { status: 200 })],
    ["the network failing", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s: 200 with an empty list, never an error", async (_label, impl) => {
    m.fetch.mockImplementation(impl);
    const res = await call({ q: "Powerleague Croy", session: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
  });

  it("the cap's storage throwing is an empty list too", async () => {
    m.claimThrows = true;
    const res = await call({ q: "Powerleague Croy", session: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("LOGS: ids, counts and reason codes only. Never the typed text, a place, an address, a URL, a token or the key", async () => {
    await call({ q: "Powerleague Croy", session: TOKEN });
    m.allowed = false;
    await call({ q: "Powerleague Croy", session: TOKEN });
    m.allowed = true;
    m.fetch.mockImplementation(async () => json({ error: { message: "Powerleague Croy refused for unit-test-key" } }, 403));
    await call({ q: "Powerleague Croy", session: TOKEN });
    m.fetch.mockImplementation(async () => Promise.reject(new TypeError("fetch failed https://places.googleapis.com/v1/places:autocomplete")));
    await call({ q: "Powerleague Croy", session: TOKEN });

    const all = lines.join("\n");
    expect(all).toMatch(/\[venue-suggest\] user=user-a outcome=ok count=5/);
    expect(all).toMatch(/\[venue-suggest\] user=user-a outcome=capped/);
    expect(all).toMatch(/\[venue-suggest\] user=user-a outcome=error reason=denied/);
    expect(all).toMatch(/\[venue-suggest\] user=user-a outcome=error reason=failed/);
    expect(all).not.toMatch(/Powerleague|Croy|Town|ChIJ|https?:|unit-test-key/);
    expect(all).not.toContain(TOKEN);
  });
});
