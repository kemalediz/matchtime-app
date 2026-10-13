/**
 * src/lib/places.ts: the two calls MatchTime makes to Google's Places
 * API (New). Autocomplete as the organiser types, and Place Details for
 * the one place they pick. What each sends, what it reads back, and that
 * no failure of Google's becomes an exception, a long wait or a log line
 * with the organiser's words in it.
 *
 * `fetch` is always a stub. No test in this file touches the network.
 * The response bodies are Google's documented shapes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PLACES_TIMEOUT_MS, placeDetails, placesAutocomplete } from "@/lib/places";
import { outboundFetch } from "@/lib/geocode-test-seam";

const TOKEN = "3f2c1d7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const prediction = (placeId: string, main: string, secondary?: string) => ({
  placePrediction: {
    place: `places/${placeId}`,
    placeId,
    text: { text: secondary ? `${main}, ${secondary}` : main, matches: [{ endOffset: 4 }] },
    structuredFormat: {
      mainText: { text: main, matches: [{ endOffset: 4 }] },
      ...(secondary ? { secondaryText: { text: secondary } } : {}),
    },
    types: ["sports_complex", "establishment", "point_of_interest"],
  },
});

const AUTOCOMPLETE = {
  suggestions: [
    prediction("ChIJ_croydon_0001", "Powerleague Croydon", "Purley Way, Croydon, UK"),
    prediction("ChIJ_shoreditch_02", "Powerleague Shoreditch", "Braithwaite Street, London, UK"),
  ],
};

const DETAILS = {
  id: "ChIJ_croydon_0001",
  displayName: { text: "Powerleague Croydon", languageCode: "en" },
  formattedAddress: "Purley Way, Croydon CR0 4RQ, UK",
  location: { latitude: 51.3562, longitude: -0.1167 },
};

const asFetch = (f: unknown) => f as typeof fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("placesAutocomplete", () => {
  it("with no key it is off: nothing is fetched", async () => {
    const fetchImpl = vi.fn();
    expect(
      await placesAutocomplete({ input: "Powerleague", sessionToken: TOKEN, languageCode: "en" }, { key: "", fetchImpl: asFetch(fetchImpl) }),
    ).toEqual({ status: "off" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the input, the session token and the language, with the key in a header and never in the URL", async () => {
    const fetchImpl = vi.fn(async () => json(AUTOCOMPLETE));
    await placesAutocomplete(
      { input: "Powerleague Croy", sessionToken: TOKEN, languageCode: "tr" },
      { key: "test-key", fetchImpl: asFetch(fetchImpl) },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-goog-fieldmask")).toBe(
      "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text",
    );
    // No country restriction: clubs play in the UK and in Turkey.
    expect(JSON.parse(init.body as string)).toEqual({ input: "Powerleague Croy", sessionToken: TOKEN, languageCode: "tr" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the place id, the primary text and the secondary text of each suggestion, and nothing else", async () => {
    const fetchImpl = vi.fn(async () => json(AUTOCOMPLETE));
    const got = await placesAutocomplete({ input: "Powerleague", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(fetchImpl) });
    expect(got).toEqual({
      status: "ok",
      suggestions: [
        { placeId: "ChIJ_croydon_0001", primary: "Powerleague Croydon", secondary: "Purley Way, Croydon, UK" },
        { placeId: "ChIJ_shoreditch_02", primary: "Powerleague Shoreditch", secondary: "Braithwaite Street, London, UK" },
      ],
    });
  });

  it("at most five, in Google's order", async () => {
    const many = { suggestions: Array.from({ length: 9 }, (_, i) => prediction(`ChIJ_place_number_${i}`, `Pitch ${i}`, "Town")) };
    const got = await placesAutocomplete({ input: "Pitch", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(many))) });
    expect(got.status === "ok" && got.suggestions.map((s) => s.primary)).toEqual(["Pitch 0", "Pitch 1", "Pitch 2", "Pitch 3", "Pitch 4"]);
  });

  it("no secondary text is an empty string; a prediction with no structured text falls back to its full text", async () => {
    const body = {
      suggestions: [
        prediction("ChIJ_no_secondary_1", "The Cage"),
        { placePrediction: { placeId: "ChIJ_text_only_0002", text: { text: "Hackney Marshes, London" } } },
      ],
    };
    const got = await placesAutocomplete({ input: "cage", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(body))) });
    expect(got).toEqual({
      status: "ok",
      suggestions: [
        { placeId: "ChIJ_no_secondary_1", primary: "The Cage", secondary: "" },
        { placeId: "ChIJ_text_only_0002", primary: "Hackney Marshes, London", secondary: "" },
      ],
    });
  });

  it("skips what is not a place: a query prediction, a prediction with no id or an unusable id, a nameless one", async () => {
    const body = {
      suggestions: [
        { queryPrediction: { text: { text: "football near me" } } },
        { placePrediction: { structuredFormat: { mainText: { text: "No id" } } } },
        { placePrediction: { placeId: "bad/../id", structuredFormat: { mainText: { text: "Bad id" } } } },
        { placePrediction: { placeId: "ChIJ_nameless_0003" } },
        null,
        prediction("ChIJ_kept_one_0004", "Kept"),
      ],
    };
    const got = await placesAutocomplete({ input: "foot", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(body))) });
    expect(got).toEqual({ status: "ok", suggestions: [{ placeId: "ChIJ_kept_one_0004", primary: "Kept", secondary: "" }] });
  });

  it("Google answering with no suggestions (an empty object) is an empty list, not an error", async () => {
    const got = await placesAutocomplete({ input: "zzzz", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json({}))) });
    expect(got).toEqual({ status: "ok", suggestions: [] });
  });

  it.each([
    [403, "denied"],
    [429, "quota"],
    [500, "http-500"],
  ])("HTTP %i is an error with code %s, never a throw", async (status, code) => {
    const body = { error: { code: status, message: "Places API (New) has not been used in project 123", status: "PERMISSION_DENIED" } };
    const got = await placesAutocomplete({ input: "Powerleague", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(body, status))) });
    expect(got).toEqual({ status: "error", code });
  });

  it("a body that is not JSON, and a network failure, are errors", async () => {
    const notJson = asFetch(vi.fn(async () => new Response("<html>", { status: 200 })));
    expect(await placesAutocomplete({ input: "Powerleague", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: notJson })).toEqual({
      status: "error",
      code: "failed",
    });
    const down = asFetch(vi.fn(async () => {
      throw new TypeError("fetch failed: https://places.googleapis.com/v1/places:autocomplete");
    }));
    expect(await placesAutocomplete({ input: "Powerleague", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: down })).toEqual({
      status: "error",
      code: "failed",
    });
  });

  it("gives up after the timeout (2.5 seconds by default)", async () => {
    expect(PLACES_TIMEOUT_MS).toBe(2500);
    const hang = asFetch((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
    const started = Date.now();
    const got = await placesAutocomplete({ input: "Powerleague", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: hang, timeoutMs: 40 });
    expect(got).toEqual({ status: "error", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("placeDetails", () => {
  it("with no key it is off: nothing is fetched", async () => {
    const fetchImpl = vi.fn();
    expect(await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "", fetchImpl: asFetch(fetchImpl) })).toEqual({
      status: "off",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("GETs the place with a field mask of exactly id, displayName, formattedAddress and location, and the SAME session token", async () => {
    const fetchImpl = vi.fn(async () => json(DETAILS));
    await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "tr" }, { key: "test-key", fetchImpl: asFetch(fetchImpl) });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://places.googleapis.com/v1/places/ChIJ_croydon_0001");
    expect(Object.fromEntries(u.searchParams)).toEqual({ sessionToken: TOKEN, languageCode: "tr" });
    expect(init.method ?? "GET").toBe("GET");
    const headers = new Headers(init.headers);
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    expect(headers.get("x-goog-fieldmask")).toBe("id,displayName,formattedAddress,location");
    expect(url).not.toContain("test-key");
  });

  it("with no session token the place is still asked for, without one", async () => {
    const fetchImpl = vi.fn(async () => json(DETAILS));
    await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: null, languageCode: "en" }, { key: "k", fetchImpl: asFetch(fetchImpl) });
    const u = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(Object.fromEntries(u.searchParams)).toEqual({ languageCode: "en" });
  });

  it("a place id that could change the request path is refused without a request", async () => {
    const fetchImpl = vi.fn();
    for (const bad of ["../../v1/secret", "ChIJabcdefgh?key=x", "ChIJ abc defgh", ""]) {
      expect(await placeDetails({ placeId: bad, sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(fetchImpl) })).toEqual({
        status: "none",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the id, the name, the address and the position", async () => {
    const got = await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(DETAILS))) });
    expect(got).toEqual({
      status: "ok",
      place: {
        placeId: "ChIJ_croydon_0001",
        name: "Powerleague Croydon",
        formattedAddress: "Purley Way, Croydon CR0 4RQ, UK",
        lat: 51.3562,
        lng: -0.1167,
      },
    });
  });

  it("the id Google ANSWERS with is the one kept (a place that moved has a new id)", async () => {
    const moved = { ...DETAILS, id: "ChIJ_new_id_for_it_9" };
    const got = await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(moved))) });
    expect(got.status === "ok" && got.place.placeId).toBe("ChIJ_new_id_for_it_9");
  });

  it.each([
    [404, { status: "none" }],
    [400, { status: "none" }],
    [403, { status: "error", code: "denied" }],
    [429, { status: "error", code: "quota" }],
    [503, { status: "error", code: "http-503" }],
  ])("HTTP %i is %j", async (status, expected) => {
    const body = { error: { code: status, message: "x", status: "WHATEVER" } };
    const got = await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(body, status))) });
    expect(got).toEqual(expected);
  });

  it("an answer with no position, or out of range, is malformed: never a place at 0,0", async () => {
    for (const body of [
      { id: "ChIJ_croydon_0001", displayName: { text: "X" } },
      { ...DETAILS, location: { latitude: "51.3", longitude: -0.1 } },
      { ...DETAILS, location: { latitude: 151, longitude: -0.1 } },
      { ...DETAILS, id: 7 },
      null,
    ]) {
      const got = await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: asFetch(vi.fn(async () => json(body))) });
      expect(got).toEqual({ status: "error", code: "malformed" });
    }
  });

  it("a timeout and a network failure are errors, never a throw", async () => {
    const hang = asFetch((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
    expect(await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: hang, timeoutMs: 40 })).toEqual({
      status: "error",
      code: "timeout",
    });
    const down = asFetch(vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl: down })).toEqual({
      status: "error",
      code: "failed",
    });
  });
});

describe("what is logged", () => {
  it("never the typed words, a place name, an address, a place id, a URL or the key", async () => {
    const lines: string[] = [];
    for (const level of ["debug", "log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    const key = "SECRET-KEY-VALUE";
    const input = { input: "Powerleague Croy", sessionToken: TOKEN, languageCode: "en" };
    const place = { placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" };
    const boom = asFetch(vi.fn(async () => {
      throw new TypeError(`fetch failed for https://places.googleapis.com/v1/places/ChIJ_croydon_0001 key=${key}`);
    }));
    await placesAutocomplete(input, { key, fetchImpl: asFetch(vi.fn(async () => json(AUTOCOMPLETE))) });
    await placesAutocomplete(input, { key, fetchImpl: asFetch(vi.fn(async () => json({ error: { message: `bad key ${key}` } }, 403))) });
    await placesAutocomplete(input, { key, fetchImpl: boom });
    await placeDetails(place, { key, fetchImpl: asFetch(vi.fn(async () => json(DETAILS))) });
    await placeDetails(place, { key, fetchImpl: asFetch(vi.fn(async () => json({ error: { message: "Powerleague Croydon not found" } }, 404))) });
    await placeDetails(place, { key, fetchImpl: boom });

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).not.toMatch(/Powerleague|Croy|Purley|CR0|ChIJ|51\.35|https?:|SECRET-KEY-VALUE/);
    expect(all).not.toContain(TOKEN);
  });
});

describe("the test seam", () => {
  it("under MT_TEST_MODE=1 the real network is never used: autocomplete answers nothing, details is a 404", async () => {
    const fetchImpl = outboundFetch({ MT_TEST_MODE: "1" });
    expect(await placesAutocomplete({ input: "Powerleague", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl })).toEqual({
      status: "ok",
      suggestions: [],
    });
    expect(await placeDetails({ placeId: "ChIJ_croydon_0001", sessionToken: TOKEN, languageCode: "en" }, { key: "k", fetchImpl })).toEqual({
      status: "none",
    });
  });
});
