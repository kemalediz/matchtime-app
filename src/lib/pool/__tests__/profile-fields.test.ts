/**
 * The fields of a pool profile, as the /play form and the manage page send
 * them (slice L2): one validator for both, built on L1's field rules
 * (district, availability, sport choice), never a copy of them.
 */
import { describe, expect, it } from "vitest";
import { POOL_SIGNUP } from "../rules";
import { POOL_SPORT_KEYS, type LiveSports } from "../sports";
import { normaliseDisplayName, validatePoolFields, validatePoolSignup, readSignupSource } from "../profile-fields";

/** Every catalogue sport and Other switched on: the rules below, apart
 *  from the live switch, hold for any sport. */
const ALL: { live: LiveSports } = { live: { sports: POOL_SPORT_KEYS, other: true } };

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
    const r = validatePoolFields(GOOD, ALL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      displayName: "Ali Kaya",
      areaDistrict: "SM1",
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

  it("a postcode area is the only way: chosen pitches are refused (2026-10-25)", () => {
    expect(validatePoolFields({ ...GOOD, area: { kind: "venues", venueIds: ["v1", "v2"] } }, ALL)).toMatchObject({ ok: false, errors: { area: "required" } });
  });

  it("pitch ids sent alongside a postcode area are ignored, never stored", () => {
    const r = validatePoolFields({ ...GOOD, area: { kind: "district", district: "sm1", venueIds: ["v1"] }, venueIds: ["v1"] }, ALL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.areaDistrict).toBe("SM1");
      expect(r.value).not.toHaveProperty("venueIds");
    }
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

  it("the postcode area is required", () => {
    expect(validatePoolFields({ ...GOOD, area: null })).toMatchObject({ ok: false, errors: { area: "required" } });
    expect(validatePoolFields({ ...GOOD, area: undefined })).toMatchObject({ ok: false, errors: { area: "required" } });
    expect(validatePoolFields({ ...GOOD, area: { kind: "district", district: "" } })).toMatchObject({ ok: false, errors: { area: "district" } });
  });

  it("availability errors are L1's (a from after its to, a bad time)", () => {
    expect(validatePoolFields({ ...GOOD, availability: [{ day: 1, from: "22:00", to: "19:00" }] })).toMatchObject({ ok: false, errors: { availability: "bad-range" } });
    expect(validatePoolFields({ ...GOOD, availability: [{ day: 1, from: "25:00", to: "26:00" }] })).toMatchObject({ ok: false, errors: { availability: "bad-time" } });
    const many = Array.from({ length: POOL_SIGNUP.maxRanges + 1 }, (_, i) => ({ day: i % 7, from: `${String(i % 24).padStart(2, "0")}:00`, to: "24:00" }));
    expect(validatePoolFields({ ...GOOD, availability: many })).toMatchObject({ ok: false, errors: { availability: "too-many" } });
  });

  it("sport errors are the catalogue's, and a sport only once", () => {
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "curling" }] }, ALL)).toMatchObject({ ok: false, errors: { sports: "bad-sport" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "tennis", formats: [2] }] }, ALL)).toMatchObject({ ok: false, errors: { sports: "bad-format" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "other", otherName: "" }] }, ALL)).toMatchObject({ ok: false, errors: { sports: "other-needs-name" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "football" }, { sport: "football" }] }, ALL)).toMatchObject({ ok: false, errors: { sports: "duplicate" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "other", otherName: "Frisbee" }, { sport: "other", otherName: "frisbee" }] }, ALL)).toMatchObject({ ok: false, errors: { sports: "duplicate" } });
  });

  it("only a live sport: football today; basketball, padel and Other are refused", () => {
    const football = { ...GOOD, sports: [{ sport: "football", formats: [5] }] };
    expect(validatePoolFields(football).ok).toBe(true);
    for (const sports of [[{ sport: "basketball", formats: [5] }], [{ sport: "padel" }], [{ sport: "other", otherName: "Frisbee" }], [{ sport: "football" }, { sport: "tennis" }]]) {
      expect(validatePoolFields({ ...GOOD, sports })).toMatchObject({ ok: false, errors: { sports: "bad-sport" } });
      expect(validatePoolSignup({ ...GOOD, sports, adult: true, consent: true })).toMatchObject({ ok: false, errors: { sports: "bad-sport" } });
    }
  });

  it("switching a sport on in LIVE_SPORTS is all it takes for it to be accepted", () => {
    const live: LiveSports = { sports: ["football", "basketball"], other: false };
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "basketball", formats: [3] }] }, { live }).ok).toBe(true);
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "padel" }] }, { live })).toMatchObject({ ok: false, errors: { sports: "bad-sport" } });
  });

  it("a sport no longer live that is already on his profile is kept when he saves (manage page)", () => {
    const sports = [{ sport: "football" }, { sport: "padel", level: "novice" }, { sport: "other", otherName: "Frisbee" }];
    const r = validatePoolFields({ ...GOOD, sports }, { keep: ["padel:", "other:frisbee"] });
    expect(r.ok && r.value.sports.map((s) => s.sport)).toEqual(["football", "padel", "other"]);
    // Only what is already saved: another non-live sport is still refused.
    expect(validatePoolFields({ ...GOOD, sports: [...sports, { sport: "tennis" }] }, { keep: ["padel:", "other:frisbee"] })).toMatchObject({ ok: false, errors: { sports: "bad-sport" } });
    expect(validatePoolFields({ ...GOOD, sports: [{ sport: "other", otherName: "Kabaddi" }] }, { keep: ["other:frisbee"] })).toMatchObject({ ok: false, errors: { sports: "bad-sport" } });
  });

  it("unknown languages are English (normaliseLang), never an error", () => {
    const r = validatePoolFields({ ...GOOD, language: "de" }, ALL);
    expect(r.ok && r.value.language).toBe("en");
  });
});

describe("validatePoolSignup: the fields, plus 18+ and consent, both required", () => {
  it("passes only with both ticked, as true", () => {
    expect(validatePoolSignup({ ...GOOD, adult: true, consent: true }, ALL).ok).toBe(true);
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

  it("refuses a link with no slash or scheme (a domain-like word)", () => {
    for (const n of ["Visit evil.com", "bit.ly abc", "join t.me x", "wa.me/447700", "ali@mail.co", "Ali 0770 090", "+44 7700 900123"]) {
      expect(normaliseDisplayName(n), n).toBeNull();
    }
  });

  it("keeps names with initials and dots that are not links", () => {
    for (const n of ["A.J. Smith", "Ali K.", "St.John Baker", "Jean-Luc O'Neill"]) expect(normaliseDisplayName(n), n).toBe(n);
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
