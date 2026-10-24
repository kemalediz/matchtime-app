/**
 * The fields of a pool profile, as the /play form and the manage page send
 * them (slice L2): one validator for both, built on L1's field rules
 * (district, availability, sport choice), never a copy of them.
 */
import { describe, expect, it } from "vitest";
import { POOL_SIGNUP } from "../rules";
import { normaliseDisplayName, validatePoolFields, validatePoolSignup, readSignupSource } from "../profile-fields";

const GOOD = {
  name: "  Ali   Kaya ",
  area: { kind: "district", district: "sm1" },
  maxMiles: 3,
  availability: [
    { day: 2, from: "19:00", to: "22:00" },
    { day: 6, from: "09:00", to: "13:00" },
    { day: 2, from: "21:00", to: "23:00" },
  ],
  sports: [
    { sport: "football", formats: [7, 5], level: "intermediate" },
    { sport: "other", otherName: "Ultimate frisbee", levelText: "casual, a bit rusty" },
  ],
  language: "tr",
};

describe("validatePoolFields", () => {
  it("normalises a good profile", () => {
    const r = validatePoolFields(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      displayName: "Ali Kaya",
      areaDistrict: "SM1",
      venueIds: [],
      maxMiles: 3,
      availability: [
        { day: 2, fromMin: 19 * 60, toMin: 23 * 60 },
        { day: 6, fromMin: 9 * 60, toMin: 13 * 60 },
      ],
      sports: [
        { sport: "football", otherName: "", level: "intermediate", levelText: null, formats: [5, 7] },
        { sport: "other", otherName: "Ultimate frisbee", level: null, levelText: "casual, a bit rusty", formats: [] },
      ],
      language: "tr",
    });
  });

  it("chosen pitches instead of a district", () => {
    const r = validatePoolFields({ ...GOOD, area: { kind: "venues", venueIds: ["v1", "v2", "v1"] } });
    expect(r.ok && r.value).toMatchObject({ areaDistrict: null, venueIds: ["v1", "v2"] });
  });

  it("names every field that is wrong, at once", () => {
    const r = validatePoolFields({ name: " ", area: { kind: "district", district: "SM1 1AA" }, maxMiles: 4, availability: [], sports: [], language: "xx" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual({ name: "required", area: "district", maxMiles: "invalid", availability: "none", sports: "none" });
  });

  it("never a full postcode (data held: the district only)", () => {
    const r = validatePoolFields({ ...GOOD, area: { kind: "district", district: "SM1 2AB" } });
    expect(!r.ok && r.errors.area).toBe("district");
  });

  it("no pitches chosen, or too many", () => {
    expect(validatePoolFields({ ...GOOD, area: { kind: "venues", venueIds: [] } })).toMatchObject({ ok: false, errors: { area: "venues" } });
    const many = Array.from({ length: POOL_SIGNUP.maxVenues + 1 }, (_, i) => `v${i}`);
    expect(validatePoolFields({ ...GOOD, area: { kind: "venues", venueIds: many } })).toMatchObject({ ok: false, errors: { area: "venues" } });
    expect(validatePoolFields({ ...GOOD, area: null })).toMatchObject({ ok: false, errors: { area: "required" } });
  });

  it("availability errors are L1's (a from after its to, a bad time)", () => {
    expect(validatePoolFields({ ...GOOD, availability: [{ day: 1, from: "22:00", to: "19:00" }] })).toMatchObject({ ok: false, errors: { availability: "bad-range" } });
    expect(validatePoolFields({ ...GOOD, availability: [{ day: 1, from: "25:00", to: "26:00" }] })).toMatchObject({ ok: false, errors: { availability: "bad-time" } });
    const many = Array.from({ length: POOL_SIGNUP.maxRanges + 1 }, (_, i) => ({ day: i % 7, from: `${String(i % 24).padStart(2, "0")}:00`, to: "24:00" }));
    expect(validatePoolFields({ ...GOOD, availability: many })).toMatchObject({ ok: false, errors: { availability: "too-many" } });
  });

  it("sport errors are the catalogue's, and a sport only once", () => {
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "curling" }] })).toMatchObject({ ok: false, errors: { sports: "bad-sport" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "tennis", formats: [2] }] })).toMatchObject({ ok: false, errors: { sports: "bad-format" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "other", otherName: "" }] })).toMatchObject({ ok: false, errors: { sports: "other-needs-name" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "football" }, { sport: "football" }] })).toMatchObject({ ok: false, errors: { sports: "duplicate" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "other", otherName: "Frisbee" }, { sport: "other", otherName: "frisbee" }] })).toMatchObject({ ok: false, errors: { sports: "duplicate" } });
  });

  it("unknown languages are English (normaliseLang), never an error", () => {
    const r = validatePoolFields({ ...GOOD, language: "de" });
    expect(r.ok && r.value.language).toBe("en");
  });
});

describe("validatePoolSignup: the fields, plus 18+ and consent, both required", () => {
  it("passes only with both ticked, as true", () => {
    expect(validatePoolSignup({ ...GOOD, adult: true, consent: true }).ok).toBe(true);
    expect(validatePoolSignup({ ...GOOD, adult: "true", consent: true })).toMatchObject({ ok: false, errors: { adult: "required" } });
    expect(validatePoolSignup({ ...GOOD, adult: true })).toMatchObject({ ok: false, errors: { consent: "required" } });
    expect(validatePoolSignup({ ...GOOD })).toMatchObject({ ok: false, errors: { adult: "required", consent: "required" } });
  });
});

describe("normaliseDisplayName", () => {
  it("trims, collapses spaces and caps the length", () => {
    expect(normaliseDisplayName("  Ali  Kaya ")).toBe("Ali Kaya");
    expect(normaliseDisplayName("x".repeat(POOL_SIGNUP.nameMax + 1))).toBeNull();
    expect(normaliseDisplayName("")).toBeNull();
    expect(normaliseDisplayName(7)).toBeNull();
  });

  it("refuses a phone number or a link typed as a name", () => {
    expect(normaliseDisplayName("07700 900123")).toBeNull();
    expect(normaliseDisplayName("https://spam.example")).toBeNull();
  });
});

describe("readSignupSource: where the visitor came from, off the URL", () => {
  it("a campaign code", () => {
    expect(readSignupSource({ c: "LI-Kemal" })).toEqual({ campaignCode: "li-kemal", referralCode: null });
  });
  it("a friend's share code", () => {
    expect(readSignupSource({ ref: "Ab12Cd" })).toEqual({ campaignCode: null, referralCode: "Ab12Cd" });
  });
  it("junk is dropped, never stored", () => {
    expect(readSignupSource({ c: "<script>", ref: "x" })).toEqual({ campaignCode: null, referralCode: null });
    expect(readSignupSource({})).toEqual({ campaignCode: null, referralCode: null });
    expect(readSignupSource({ c: ["a", "b"] })).toEqual({ campaignCode: null, referralCode: null });
  });
});
