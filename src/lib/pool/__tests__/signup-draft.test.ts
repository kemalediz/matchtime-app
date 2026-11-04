/**
 * The /play sign-up's unsent draft (Kemal, 2026-10-27): what he typed, kept
 * in this tab so a reload or a back navigation loses nothing. Read
 * defensively: anything odd is dropped, never trusted (the validator still
 * runs on send). Since the short form (2026-11-04) the draft is his name,
 * postcode area and days only, under a new key, so an older draft of the
 * long form is simply not read.
 */
import { describe, expect, it } from "vitest";
import { emptyShortForm, toggleShortDay } from "../short-form";
import { decodeSignupDraft, encodeSignupDraft, SIGNUP_DRAFT_KEY } from "../signup-draft";

const base = emptyShortForm();

function typed() {
  let v = { ...base, name: "Kemal E", district: "SM1" };
  v = toggleShortDay(v, 2);
  v = toggleShortDay(v, 6);
  return v;
}

describe("signup draft", () => {
  it("has a versioned key, new with the short form", () => expect(SIGNUP_DRAFT_KEY).toMatch(/v2$/));

  it("round-trips what he typed", () => {
    const v = typed();
    expect(decodeSignupDraft(encodeSignupDraft(v), base)).toEqual(v);
  });

  it("keeps only the form: no ticks, no extra fields", () => {
    const raw = JSON.parse(encodeSignupDraft(typed()));
    expect(Object.keys(raw).sort()).toEqual(["form", "v"]);
    expect(Object.keys(raw.form).sort()).toEqual(["days", "district", "name"]);
  });

  it("nothing, junk, or the long form's draft gives nothing", () => {
    for (const raw of [null, "", "not json", "null", "42", "[]", JSON.stringify({ v: 1, form: { name: "Ali" } }), JSON.stringify({ v: 2 })]) {
      expect(decodeSignupDraft(raw, base)).toBeNull();
    }
  });

  it("drops what is malformed and keeps the rest", () => {
    const raw = JSON.stringify({ v: 2, form: { name: "Ali", district: 7, days: [2, 9, "x", 2, 0], phone: "+447700900000" } });
    const v = decodeSignupDraft(raw, base)!;
    expect(v.name).toBe("Ali");
    expect(v.district).toBe("");
    expect(v.days).toEqual([2, 0]);
    expect(v).not.toHaveProperty("phone");
  });

  it("caps the length of what it reads back", () => {
    const raw = JSON.stringify({ v: 2, form: { name: "x".repeat(5000), district: "y".repeat(500) } });
    const v = decodeSignupDraft(raw, base)!;
    expect(v.name.length).toBeLessThanOrEqual(200);
    expect(v.district.length).toBeLessThanOrEqual(40);
  });
});
