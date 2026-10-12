/**
 * Venue location, the pure rules: what is sent to Google, how sure a
 * match is, the dedupe key, the country hint and what the page is told.
 * No database and no network anywhere in this file.
 */
import { describe, it, expect } from "vitest";
import type { GeocodeHit } from "../geocode";
import {
  CLEARED_VENUE_LINK,
  VENUE_LOOKUPS_PER_CLUB_PER_DAY,
  VENUE_PENDING_WINDOW_MS,
  withoutVenueBookkeeping,
  buildGeocodeQuery,
  classifyConfidence,
  clubCountry,
  countryFromPhone,
  isPlaceholderVenue,
  normaliseVenueText,
  regionForCountry,
  venueLocationView,
  venueMapUrl,
  venueQueryKey,
} from "../venue-location-rules";

const hit = (over: Partial<GeocodeHit> = {}): GeocodeHit => ({
  placeId: "ChIJ_powerleague_shoreditch",
  formattedAddress: "Braithwaite St, London E1 6GJ, UK",
  lat: 51.5229,
  lng: -0.0757,
  types: ["establishment", "point_of_interest"],
  partialMatch: false,
  locationType: "GEOMETRIC_CENTER",
  countryCode: "GB",
  ...over,
});

describe("normalising the venue text", () => {
  it("ignores case, punctuation, accents and spacing", () => {
    expect(normaliseVenueText("  Powerleague,  SHOREDITCH! ")).toBe("powerleague shoreditch");
    expect(normaliseVenueText("Halı Saha İstanbul")).toBe("hali saha istanbul");
    expect(normaliseVenueText("Goals - North Cheam")).toBe("goals north cheam");
  });

  it("a placeholder is not a place", () => {
    for (const x of ["", "  ", "TBD", "tba", "-", "?"]) expect(isPlaceholderVenue(x), x).toBe(true);
    expect(isPlaceholderVenue("Goals North Cheam")).toBe(false);
  });

  it("the dedupe key is the country plus the normalised words", () => {
    expect(venueQueryKey("Powerleague Shoreditch", "GB")).toBe("GB|powerleague shoreditch");
    expect(venueQueryKey("powerleague  shoreditch.", "GB")).toBe("GB|powerleague shoreditch");
    expect(venueQueryKey("Powerleague Shoreditch", "TR")).not.toBe(venueQueryKey("Powerleague Shoreditch", "GB"));
    expect(venueQueryKey("Powerleague Shoreditch", null)).toBe("--|powerleague shoreditch");
  });
});

describe("the country hint", () => {
  it("comes from the organiser's phone country code", () => {
    expect(countryFromPhone("+447700900001")).toBe("GB");
    expect(countryFromPhone("+905321234567")).toBe("TR");
    expect(countryFromPhone("+353871234567")).toBe("IE");
    expect(countryFromPhone("+35799123456")).toBe("CY");
  });

  it("a shared or unknown code gives no country", () => {
    expect(countryFromPhone("+12025550123")).toBeNull(); // +1 is many countries
    expect(countryFromPhone("+9999999")).toBeNull();
    expect(countryFromPhone(null)).toBeNull();
    expect(countryFromPhone("07700900001")).toBeNull();
  });

  it("the phone wins over the language: a Turkish speaking club in London is in the UK", () => {
    expect(clubCountry({ ownerPhone: "+447700900001", language: "tr" })).toBe("GB");
  });

  it("with no usable phone, Turkish means Turkey and English means nothing", () => {
    expect(clubCountry({ ownerPhone: null, language: "tr" })).toBe("TR");
    expect(clubCountry({ ownerPhone: null, language: "en" })).toBeNull();
    expect(clubCountry({ ownerPhone: "+12025550123", language: "en" })).toBeNull();
  });

  it("Google's region is the country's web suffix, and the UK's is uk", () => {
    expect(regionForCountry("GB")).toBe("uk");
    expect(regionForCountry("TR")).toBe("tr");
  });
});

describe("what is sent to Google", () => {
  it("is the venue text and the region, and nothing else", () => {
    expect(buildGeocodeQuery("  Powerleague   Shoreditch ", "GB")).toEqual({
      address: "Powerleague Shoreditch",
      region: "uk",
    });
    expect(buildGeocodeQuery("Goals", null)).toEqual({ address: "Goals" });
  });

  it("is capped in length", () => {
    expect(buildGeocodeQuery("x".repeat(500), null).address.length).toBe(200);
  });
});

describe("how sure the match is", () => {
  const base = { query: "Powerleague Shoreditch", expectedCountry: "GB" };

  it("a named place, matched whole, in the right country: high", () => {
    expect(classifyConfidence({ ...base, hit: hit() })).toBe("high");
    expect(classifyConfidence({ ...base, hit: hit({ types: ["premise"], locationType: "ROOFTOP" }) })).toBe("high");
  });

  it("a partial match: low", () => {
    expect(classifyConfidence({ ...base, hit: hit({ partialMatch: true }) })).toBe("low");
  });

  it("a whole town or a road, not a place: low", () => {
    expect(
      classifyConfidence({ ...base, hit: hit({ types: ["locality", "political"], locationType: "APPROXIMATE" }) }),
    ).toBe("low");
    expect(classifyConfidence({ ...base, hit: hit({ types: ["route"] }) })).toBe("low");
    expect(classifyConfidence({ ...base, hit: hit({ types: ["postal_code"] }) })).toBe("low");
  });

  it("an approximate position: low, whatever the type says", () => {
    expect(classifyConfidence({ ...base, hit: hit({ locationType: "APPROXIMATE" }) })).toBe("low");
  });

  it("one generic word (Powerleague has dozens of sites): low", () => {
    expect(classifyConfidence({ ...base, query: "Powerleague", hit: hit() })).toBe("low");
    expect(classifyConfidence({ ...base, query: " Goals! ", hit: hit() })).toBe("low");
  });

  it("a place in another country than the club's: low", () => {
    expect(classifyConfidence({ ...base, hit: hit({ countryCode: "US" }) })).toBe("low");
    // With no country known on either side there is nothing to compare.
    expect(classifyConfidence({ ...base, expectedCountry: null, hit: hit({ countryCode: "US" }) })).toBe("high");
    expect(classifyConfidence({ ...base, hit: hit({ countryCode: null }) })).toBe("high");
  });

  it("a full street address is a place only when Google has the rooftop", () => {
    const q = { query: "12 Whiston Road, London E2 8BN", expectedCountry: "GB" };
    expect(classifyConfidence({ ...q, hit: hit({ types: ["street_address"], locationType: "ROOFTOP" }) })).toBe("high");
    expect(
      classifyConfidence({ ...q, hit: hit({ types: ["street_address"], locationType: "RANGE_INTERPOLATED" }) }),
    ).toBe("low");
  });
});

describe("the map link on the page", () => {
  it("is a plain Google Maps URL from the place id and coordinates", () => {
    expect(venueMapUrl({ placeId: "ChIJ_abc", lat: 51.5, lng: -0.1 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=51.5%2C-0.1&query_place_id=ChIJ_abc",
    );
    expect(venueMapUrl({ placeId: null, lat: 51.5, lng: -0.1 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=51.5%2C-0.1",
    );
    expect(venueMapUrl({ placeId: null, lat: null, lng: null })).toBeNull();
  });
});

describe("what the page is told", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const row = {
    venue: "Powerleague Shoreditch",
    venueId: null as string | null,
    venueConfidence: null as string | null,
    venueLookupStatus: null as string | null,
    venueResolvedAt: null as Date | null,
    venueConfirmedAt: null as Date | null,
    venueRef: null as null | { placeId: string | null; formattedAddress: string | null; lat: number | null; lng: number | null },
  };
  const place = { placeId: "ChIJ_abc", formattedAddress: "Braithwaite St, London E1 6GJ, UK", lat: 51.5, lng: -0.1 };

  it("found: the address, a map link, how sure, and whether it is confirmed", () => {
    const v = venueLocationView(
      { ...row, venueId: "v1", venueConfidence: "low", venueLookupStatus: "found", venueResolvedAt: now, venueRef: place },
      now,
    );
    expect(v).toEqual({
      state: "found",
      address: "Braithwaite St, London E1 6GJ, UK",
      coords: null,
      mapUrl: "https://www.google.com/maps/search/?api=1&query=51.5%2C-0.1&query_place_id=ChIJ_abc",
      confidence: "low",
      confirmed: false,
    });
    const c = venueLocationView(
      { ...row, venueId: "v1", venueConfidence: "high", venueConfirmedAt: now, venueResolvedAt: now, venueRef: place },
      now,
    );
    expect(c).toMatchObject({ state: "found", confidence: "high", confirmed: true });
  });

  it("a pin from a pasted link has no address: the page gets rounded coordinates", () => {
    const v = venueLocationView(
      {
        ...row,
        venueId: "v2",
        venueConfidence: "high",
        venueConfirmedAt: now,
        venueRef: { placeId: null, formattedAddress: null, lat: 51.5229437, lng: -0.0757291 },
      },
      now,
    );
    expect(v).toMatchObject({ state: "found", address: null, coords: "51.52294, -0.07573" });
  });

  it("an unknown confidence is treated as low", () => {
    const v = venueLocationView({ ...row, venueId: "v1", venueConfidence: null, venueRef: place }, now);
    expect(v).toMatchObject({ confidence: "low" });
  });

  it("NEVER LOOKED UP (every weekly game that existed before this feature): its own state, not 'not found'", () => {
    expect(venueLocationView(row, now)).toEqual({ state: "never" });
    expect(venueLocationView({ ...row, venue: "TBD" }, now)).toEqual({ state: "never" });
  });

  it("FOUND NOTHING only when Google really answered with no result", () => {
    expect(venueLocationView({ ...row, venueLookupStatus: "none", venueResolvedAt: now }, now)).toEqual({ state: "none" });
  });

  it("LOOKUP FAILED or CAPPED: 'could not check', never 'not found'", () => {
    for (const status of ["failed", "capped"]) {
      expect(venueLocationView({ ...row, venueLookupStatus: status, venueResolvedAt: now }, now), status).toEqual({ state: "failed" });
    }
  });

  it("PENDING only when a lookup was scheduled, whatever else was saved", () => {
    const scheduled = { ...row, venueLookupStatus: "pending", venueResolvedAt: new Date(now.getTime() - 5_000) };
    expect(venueLocationView(scheduled, now)).toEqual({ state: "pending" });
    // An edit of the time only schedules nothing: the row says nothing is pending.
    expect(venueLocationView({ ...row, venueLookupStatus: "none", venueResolvedAt: new Date(now.getTime() - 1_000) }, now).state).toBe("none");
    expect(venueLocationView(row, now).state).toBe("never");
  });

  it("a lookup that was scheduled and never reported back is a failure, not an endless 'looking'", () => {
    const lost = { ...row, venueLookupStatus: "pending", venueResolvedAt: new Date(now.getTime() - VENUE_PENDING_WINDOW_MS - 1) };
    expect(venueLocationView(lost, now)).toEqual({ state: "failed" });
    expect(venueLocationView({ ...row, venueLookupStatus: "pending", venueResolvedAt: null }, now)).toEqual({ state: "failed" });
  });
});

describe("venue names that are not in the Latin alphabet", () => {
  it("keep their letters: two different stadiums are two different keys", () => {
    expect(normaliseVenueText("Стадион Динамо")).toBe("стадион динамо");
    expect(normaliseVenueText("Стадион Спартак")).toBe("стадион спартак");
    expect(venueQueryKey("Стадион Динамо", null)).not.toBe(venueQueryKey("Стадион Спартак", null));
  });

  it("Greek, Arabic and a mixed-script name", () => {
    expect(normaliseVenueText("Αθήνα Arena 2")).toBe("αθηνα arena 2");
    expect(venueQueryKey("Αθήνα Arena 2", "GR")).not.toBe(venueQueryKey("Arena 2", "GR"));
    expect(normaliseVenueText("ملعب  الملك، فهد!")).toBe("ملعب الملك فهد");
    expect(normaliseVenueText("ملعب الملك فهد")).not.toBe(normaliseVenueText("ملعب الأمير فيصل"));
    expect(normaliseVenueText("Halı Saha 5 «Динамо»")).toBe("hali saha 5 динамо");
  });

  it("case folds in every script, and the Turkish handling is unchanged", () => {
    expect(normaliseVenueText("СТАДИОН ДИНАМО")).toBe(normaliseVenueText("стадион динамо"));
    expect(normaliseVenueText("Halı Saha İstanbul")).toBe("hali saha istanbul");
    expect(normaliseVenueText("ΑΘΗΝΑ")).toBe(normaliseVenueText("αθηνα"));
  });

  it("such a venue is a real venue: not a placeholder, and judged by its words", () => {
    expect(isPlaceholderVenue("Стадион Динамо")).toBe(false);
    expect(isPlaceholderVenue("ملعب")).toBe(false);
    expect(classifyConfidence({ query: "Стадион Динамо", hit: hit({ countryCode: null }), expectedCountry: null })).toBe("high");
    expect(classifyConfidence({ query: "Стадион", hit: hit({ countryCode: null }), expectedCountry: null })).toBe("low");
  });
});

it("the daily cap is a small number", () => {
  expect(VENUE_LOOKUPS_PER_CLUB_PER_DAY).toBe(10);
});

it("a member-facing activity carries none of the venue-location columns", () => {
  const row = {
    id: "act",
    venue: "Powerleague Shoreditch",
    venueId: "v1",
    venueConfidence: "high",
    venueMatchSource: "text",
    venueLookupStatus: "found",
    venueResolvedAt: new Date(),
    venueConfirmedAt: new Date(),
    venueConfirmedById: "user-1",
    sport: { name: "5s" },
  };
  expect(withoutVenueBookkeeping(row)).toEqual({ id: "act", venue: "Powerleague Shoreditch", sport: { name: "5s" } });
  expect(row.venueId, "the row itself is not mutated").toBe("v1");
});

it("the columns an edit of the venue text clears are every venue-location column", () => {
  expect(Object.keys(CLEARED_VENUE_LINK).sort()).toEqual(
    ["venueId", "venueConfidence", "venueMatchSource", "venueLookupStatus", "venueResolvedAt", "venueConfirmedAt", "venueConfirmedById"].sort(),
  );
  expect(Object.values(CLEARED_VENUE_LINK).every((v) => v === null)).toBe(true);
});
