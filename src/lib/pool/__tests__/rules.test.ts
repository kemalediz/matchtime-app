/**
 * The pool's limits and field rules (slice L1). Pure: every number here is
 * the ONE definition later slices enforce (L4 caps and quiet hours, L5
 * rounds, L7 auto-pause, the retention job). Approved spec, "Limits".
 */
import { describe, expect, it } from "vitest";
import { inQuietHours } from "../../message-hours";
import {
  POOL_CAPS,
  POOL_CONSENT_VERSION,
  POOL_MIN_AGE,
  POOL_QUIET_HOURS,
  POOL_RETENTION,
  POOL_ROUND,
  POOL_TRAVEL_MILES,
  DEFAULT_POOL_TRAVEL_MILES,
  formatMinutes,
  normaliseAvailability,
  normaliseDistrict,
  parseMinutes,
  acceptDistrictGeocode,
  pendingSignupPurgeBefore,
} from "../rules";

describe("the limits (approved spec, plain wording)", () => {
  it("2 offers a week, 1 a day, 1 per match, per player", () => {
    expect(POOL_CAPS).toMatchObject({ perPlayerPerWeek: 2, perPlayerPerDay: 1, perPlayerPerMatch: 1 });
  });

  it("a round asks up to 8, about 4 first, the rest only if places are still open", () => {
    expect(POOL_ROUND).toMatchObject({ maxOffers: 8, firstWave: 4 });
    expect(POOL_ROUND.secondWaveAfterMins).toBeGreaterThan(0);
  });

  it("3 ignored offers in a row pause the player", () => {
    expect(POOL_CAPS.ignoredInARowPause).toBe(3);
  });

  it("no offer 21:30 to 08:30 London, read through the one quiet-hours module", () => {
    expect(POOL_QUIET_HOURS).toEqual({ enabled: true, from: "21:30", to: "08:30" });
    // 21:29 and 08:30 London on a winter day (UTC = London).
    expect(inQuietHours(new Date("2026-11-10T21:29:00Z"), POOL_QUIET_HOURS)).toBe(false);
    expect(inQuietHours(new Date("2026-11-10T21:30:00Z"), POOL_QUIET_HOURS)).toBe(true);
    expect(inQuietHours(new Date("2026-11-11T08:29:00Z"), POOL_QUIET_HOURS)).toBe(true);
    expect(inQuietHours(new Date("2026-11-11T08:30:00Z"), POOL_QUIET_HOURS)).toBe(false);
  });

  it("travel distance is 1, 3, 5 or 10 miles, default 3", () => {
    expect(POOL_TRAVEL_MILES).toEqual([1, 3, 5, 10]);
    expect(DEFAULT_POOL_TRAVEL_MILES).toBe(3);
  });

  it("minimum age 18; the consent version starts at 1", () => {
    expect(POOL_MIN_AGE).toBe(18);
    expect(POOL_CONSENT_VERSION).toBe(1);
  });

  it("the 12-month rule, its 30-day grace, and pending sign-ups expire", () => {
    expect(POOL_RETENTION).toMatchObject({ inactiveMonths: 12, reconfirmGraceDays: 30, offerAnonymiseMonths: 24 });
    expect(POOL_RETENTION.pendingExpiryDays).toBeGreaterThan(0);
  });
});

describe("normaliseDistrict: a UK postcode district, never a full postcode", () => {
  it("upper-cases and trims a district", () => {
    expect(normaliseDistrict(" sm1 ")).toBe("SM1");
    expect(normaliseDistrict("SW19")).toBe("SW19");
    expect(normaliseDistrict("EC1A")).toBe("EC1A");
    expect(normaliseDistrict("N1")).toBe("N1");
  });

  it("refuses a full postcode and anything that is not a district", () => {
    expect(normaliseDistrict("SM1 2AB")).toBeNull();
    expect(normaliseDistrict("SM12AB")).toBeNull();
    expect(normaliseDistrict("Sutton")).toBeNull();
    expect(normaliseDistrict("")).toBeNull();
    expect(normaliseDistrict(null)).toBeNull();
  });
});

describe("times as minutes after midnight", () => {
  it("parses and formats HH:MM, 24:00 being the end of the day", () => {
    expect(parseMinutes("19:00")).toBe(1140);
    expect(parseMinutes("9:30")).toBe(570);
    expect(parseMinutes("24:00")).toBe(1440);
    expect(parseMinutes("24:01")).toBeNull();
    expect(parseMinutes("7pm")).toBeNull();
    expect(formatMinutes(1140)).toBe("19:00");
    expect(formatMinutes(1440)).toBe("24:00");
  });
});

describe("normaliseAvailability: days and from-to hours", () => {
  it("keeps ranges per day, sorted, several on one day allowed", () => {
    expect(
      normaliseAvailability([
        { day: 6, from: "09:00", to: "13:00" },
        { day: 2, from: "19:00", to: "22:00" },
        { day: 2, from: "07:00", to: "08:30" },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { day: 2, fromMin: 420, toMin: 510 },
        { day: 2, fromMin: 1140, toMin: 1320 },
        { day: 6, fromMin: 540, toMin: 780 },
      ],
    });
  });

  it("merges ranges that touch or overlap on the same day", () => {
    expect(
      normaliseAvailability([
        { day: 2, from: "18:00", to: "20:00" },
        { day: 2, from: "19:00", to: "22:00" },
        { day: 2, from: "22:00", to: "23:00" },
      ]),
    ).toEqual({ ok: true, value: [{ day: 2, fromMin: 1080, toMin: 1380 }] });
  });

  it("refuses an empty list, a bad day, a bad time and a range that ends before it starts", () => {
    expect(normaliseAvailability([])).toEqual({ ok: false, error: "none" });
    expect(normaliseAvailability([{ day: 7, from: "09:00", to: "10:00" }])).toEqual({ ok: false, error: "bad-day" });
    expect(normaliseAvailability([{ day: 1, from: "9am", to: "10:00" }])).toEqual({ ok: false, error: "bad-time" });
    expect(normaliseAvailability([{ day: 1, from: "22:00", to: "01:00" }])).toEqual({ ok: false, error: "bad-range" });
    expect(normaliseAvailability([{ day: 1, from: "10:00", to: "10:00" }])).toEqual({ ok: false, error: "bad-range" });
  });
});

describe("placing a postcode district (slice L2): only a real UK postcode-area result", () => {
  const hit = (over: Partial<Parameters<typeof acceptDistrictGeocode>[0]> = {}) => ({
    placeId: "p",
    formattedAddress: "Sutton SM1, UK",
    lat: 51.36,
    lng: -0.19,
    types: ["postal_code_prefix", "postal_code"],
    partialMatch: false,
    locationType: "APPROXIMATE",
    countryCode: "GB",
    ...over,
  });
  it("accepts a postcode area or postcode result in the UK", () => {
    expect(acceptDistrictGeocode(hit())).toBe(true);
    expect(acceptDistrictGeocode(hit({ types: ["postal_code"] }))).toBe(true);
  });
  it("refuses a country, a town, a partial match, or anywhere outside the UK", () => {
    expect(acceptDistrictGeocode(hit({ types: ["country", "political"] }))).toBe(false);
    expect(acceptDistrictGeocode(hit({ types: ["locality", "political"] }))).toBe(false);
    expect(acceptDistrictGeocode(hit({ partialMatch: true }))).toBe(false);
    expect(acceptDistrictGeocode(hit({ countryCode: "IE" }))).toBe(false);
    expect(acceptDistrictGeocode(hit({ countryCode: null }))).toBe(false);
  });
});

describe("housekeeping windows (slice L2)", () => {
  const NOW = new Date("2026-10-24T12:00:00Z");
  it("a waiting sign-up is deleted pendingExpiryDays after it was made", () => {
    expect(NOW.getTime() - pendingSignupPurgeBefore(NOW).getTime()).toBe(POOL_RETENTION.pendingExpiryDays * 24 * 3600_000);
  });
  it("the consent record is kept 6 years (the policy's line)", () => {
    expect(POOL_RETENTION.consentRecordYears).toBe(6);
  });
});
