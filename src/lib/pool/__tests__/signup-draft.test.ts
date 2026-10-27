/**
 * The /play sign-up's unsent draft (Kemal, 2026-10-27): what he typed, kept
 * in this tab so a reload or a back navigation loses nothing. Read
 * defensively: anything odd is dropped, never trusted (the validator still
 * runs on send).
 */
import { describe, expect, it } from "vitest";
import { defaultPoolForm, toggleDay, setSport } from "../form-state";
import { decodeSignupDraft, encodeSignupDraft, SIGNUP_DRAFT_KEY } from "../signup-draft";

const base = defaultPoolForm("en");

function typed() {
  let v = { ...base, name: "Kemal E", district: "SM1", maxMiles: 5 };
  v = toggleDay(v, 2);
  v = setSport(v, "football", { formats: [7] });
  return v;
}

describe("signup draft", () => {
  it("has a versioned key", () => expect(SIGNUP_DRAFT_KEY).toMatch(/v1$/));

  it("round-trips what he typed", () => {
    const v = typed();
    expect(decodeSignupDraft(encodeSignupDraft(v), base)).toEqual(v);
  });

  it("keeps only the form: no ticks, no extra fields", () => {
    const raw = JSON.parse(encodeSignupDraft(typed()));
    expect(Object.keys(raw).sort()).toEqual(["form", "v"]);
    expect(Object.keys(raw.form).sort()).toEqual(["days", "district", "language", "maxMiles", "name", "other", "sports"]);
  });

  it("nothing, or junk, gives nothing", () => {
    for (const raw of [null, "", "not json", "null", "42", "[]", JSON.stringify({ v: 2, form: {} }), JSON.stringify({ v: 1 })]) {
      expect(decodeSignupDraft(raw, base)).toBeNull();
    }
  });

  it("drops what is malformed and keeps the rest", () => {
    const raw = JSON.stringify({
      v: 1,
      form: {
        name: "Ali",
        district: 7,
        maxMiles: "far",
        days: { 2: [{ from: "19:00", to: "22:00" }, { from: 1 }], 9: [{ from: "10:00", to: "11:00" }], x: "y" },
        sports: { football: { on: true, formats: [7, "x"], level: "", levelText: "" }, nonsense: { on: true } },
        other: "no",
        language: "fr",
        phone: "+447700900000",
      },
    });
    const v = decodeSignupDraft(raw, base)!;
    expect(v.name).toBe("Ali");
    expect(v.district).toBe("");
    expect(v.maxMiles).toBe(base.maxMiles);
    expect(v.days).toEqual({ 2: [{ from: "19:00", to: "22:00" }] });
    expect(v.sports.football.formats).toEqual([7]);
    expect(Object.keys(v.sports).sort()).toEqual(Object.keys(base.sports).sort());
    expect(v.other).toEqual(base.other);
    expect(v.language).toBe("en");
    expect(v).not.toHaveProperty("phone");
  });

  it("caps the length of what it reads back", () => {
    const raw = JSON.stringify({ v: 1, form: { name: "x".repeat(5000), district: "y".repeat(500) } });
    const v = decodeSignupDraft(raw, base)!;
    expect(v.name.length).toBeLessThanOrEqual(200);
    expect(v.district.length).toBeLessThanOrEqual(40);
  });
});
