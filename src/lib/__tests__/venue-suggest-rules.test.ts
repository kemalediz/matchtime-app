/**
 * Venue suggestions, the pure rules: when the box asks for suggestions,
 * what a pick is, when a pick stops applying, and what the server will
 * accept from a browser as a pick.
 */
import { describe, it, expect } from "vitest";
import {
  VENUE_SUGGEST_CALLS_PER_USER_PER_HOUR,
  VENUE_SUGGEST_DEBOUNCE_MS,
  VENUE_SUGGEST_MAX,
  VENUE_SUGGEST_MIN_CHARS,
  parseVenuePick,
  pickForSubmit,
  shouldSuggest,
  suggestLanguage,
  suggestQuery,
  suggestWindowStart,
  validPlaceId,
  validSessionToken,
} from "../venue-suggest-rules";

const TOKEN = "3f2c1d7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f";
const PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";

describe("the limits", () => {
  it("are the ones the design names", () => {
    expect(VENUE_SUGGEST_MIN_CHARS).toBe(3);
    expect(VENUE_SUGGEST_MAX).toBe(5);
    expect(VENUE_SUGGEST_DEBOUNCE_MS).toBe(300);
    expect(VENUE_SUGGEST_CALLS_PER_USER_PER_HOUR).toBe(120);
  });
});

describe("shouldSuggest: when the box asks at all", () => {
  it("needs three characters, not counting spaces around them", () => {
    expect(shouldSuggest("")).toBe(false);
    expect(shouldSuggest("Po")).toBe(false);
    expect(shouldSuggest("  Po  ")).toBe(false);
    expect(shouldSuggest("Pow")).toBe(true);
    expect(shouldSuggest("Halı")).toBe(true);
  });

  it("never asks about a pasted link (the Change box takes map links)", () => {
    expect(shouldSuggest("https://maps.app.goo.gl/abc")).toBe(false);
    expect(shouldSuggest("http://example.com/x")).toBe(false);
    expect(shouldSuggest("www.google.com/maps/place/x")).toBe(false);
    expect(shouldSuggest("maps.app.goo.gl/abc")).toBe(false);
  });
});

describe("suggestQuery: what is sent on", () => {
  it("trims, collapses spaces and caps the length; null when too short or a link", () => {
    expect(suggestQuery("  Powerleague   Croy ")).toBe("Powerleague Croy");
    expect(suggestQuery("Po")).toBeNull();
    expect(suggestQuery("https://maps.app.goo.gl/abc")).toBeNull();
    expect(suggestQuery(null)).toBeNull();
    expect(suggestQuery(42)).toBeNull();
    expect(suggestQuery("x".repeat(500))).toHaveLength(120);
  });
});

describe("what a browser may send as a pick", () => {
  it("a session token is at most 36 URL-safe characters", () => {
    expect(validSessionToken(TOKEN)).toBe(true);
    expect(validSessionToken("abc_DEF-123")).toBe(true);
    expect(validSessionToken("")).toBe(false);
    expect(validSessionToken("x".repeat(37))).toBe(false);
    expect(validSessionToken("has space")).toBe(false);
    expect(validSessionToken("a&key=stolen")).toBe(false);
    expect(validSessionToken(12)).toBe(false);
  });

  it("a place id is URL-safe characters only, so it can never carry a path, a query or a host", () => {
    expect(validPlaceId(PLACE)).toBe(true);
    expect(validPlaceId("short")).toBe(false);
    expect(validPlaceId("ChIJ/../../secret")).toBe(false);
    expect(validPlaceId("ChIJabcdefgh?key=x")).toBe(false);
    expect(validPlaceId("ChIJabcdefgh#frag")).toBe(false);
    expect(validPlaceId("x".repeat(301))).toBe(false);
    expect(validPlaceId(undefined)).toBe(false);
  });

  it("parseVenuePick keeps only the two named fields, and nothing unless the place id is valid", () => {
    expect(parseVenuePick({ placeId: PLACE, sessionToken: TOKEN })).toEqual({ placeId: PLACE, sessionToken: TOKEN });
    // Everything else the browser adds is dropped: no location is ever taken from it.
    expect(
      parseVenuePick({ placeId: PLACE, sessionToken: TOKEN, lat: 1, lng: 2, formattedAddress: "anywhere", confidence: "high" }),
    ).toEqual({ placeId: PLACE, sessionToken: TOKEN });
    // A bad token costs only the session billing: the place is still resolved.
    expect(parseVenuePick({ placeId: PLACE, sessionToken: "not a token" })).toEqual({ placeId: PLACE, sessionToken: null });
    expect(parseVenuePick({ placeId: PLACE })).toEqual({ placeId: PLACE, sessionToken: null });
    expect(parseVenuePick({ placeId: "../x", sessionToken: TOKEN })).toBeNull();
    expect(parseVenuePick(null)).toBeNull();
    expect(parseVenuePick("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBeNull();
    expect(parseVenuePick([PLACE])).toBeNull();
  });
});

describe("pickForSubmit: a pick lasts only while the text is the text it put there", () => {
  const pick = { placeId: PLACE, sessionToken: TOKEN, text: "Powerleague Croydon" };

  it("the text untouched since the pick: the pick is sent", () => {
    expect(pickForSubmit(pick, "Powerleague Croydon")).toEqual({ placeId: PLACE, sessionToken: TOKEN });
  });

  it("EDITED AFTER THE PICK: the pick is dropped and it is free text again", () => {
    expect(pickForSubmit(pick, "Powerleague Croydon pitch 4")).toBeNull();
    expect(pickForSubmit(pick, "Powerleague Croydo")).toBeNull();
    expect(pickForSubmit(pick, "powerleague croydon")).toBeNull();
    expect(pickForSubmit(pick, "School cage")).toBeNull();
    expect(pickForSubmit(pick, "")).toBeNull();
  });

  it("no pick: nothing is sent", () => {
    expect(pickForSubmit(null, "Powerleague Croydon")).toBeNull();
    expect(pickForSubmit(undefined, "Powerleague Croydon")).toBeNull();
  });
});

describe("suggestLanguage", () => {
  it("is one of the two languages MatchTime speaks, English for anything else", () => {
    expect(suggestLanguage("tr")).toBe("tr");
    expect(suggestLanguage("TR-tr")).toBe("tr");
    expect(suggestLanguage("en")).toBe("en");
    expect(suggestLanguage("de")).toBe("en");
    expect(suggestLanguage(null)).toBe("en");
    expect(suggestLanguage("en&key=x")).toBe("en");
  });
});

describe("suggestWindowStart", () => {
  it("is the top of the UTC hour", () => {
    expect(suggestWindowStart(new Date("2026-10-13T14:37:55.123Z")).toISOString()).toBe("2026-10-13T14:00:00.000Z");
    expect(suggestWindowStart(new Date("2026-10-13T15:00:00.000Z")).toISOString()).toBe("2026-10-13T15:00:00.000Z");
  });
});
