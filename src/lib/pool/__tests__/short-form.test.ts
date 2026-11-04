/**
 * THE SHORT /play FORM (Kemal, 2026-11-04): name, postcode area and the
 * days, and the defaults every other field gets until he tells MatchTime
 * more on WhatsApp. Pure.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_TRAVEL_MILES } from "../rules";
import { validatePoolSignup, validatePublicPoolSignup } from "../profile-fields";
import {
  SHORT_FORM_DEFAULTS,
  emptyShortForm,
  expandShortSignup,
  isShortSignup,
  toShortPayload,
  toggleShortDay,
} from "../short-form";

const TICKS = { adult: true, consent: true };

describe("the defaults", () => {
  it("are the pool's own: 3 miles, any hour of a chosen day, football in any format, no level", () => {
    expect(SHORT_FORM_DEFAULTS.maxMiles).toBe(DEFAULT_POOL_TRAVEL_MILES);
    expect(SHORT_FORM_DEFAULTS.maxMiles).toBe(3);
    expect(SHORT_FORM_DEFAULTS.from).toBe("00:00");
    expect(SHORT_FORM_DEFAULTS.to).toBe("24:00");
    expect(SHORT_FORM_DEFAULTS.sport).toBe("football");
    expect(SHORT_FORM_DEFAULTS.formats).toEqual([]);
    expect(SHORT_FORM_DEFAULTS.level).toBeNull();
  });
});

describe("the form's value", () => {
  it("starts empty, with the friend's name when a friend link gives one", () => {
    expect(emptyShortForm()).toEqual({ name: "", district: "", days: [] });
    expect(emptyShortForm("Ali")).toEqual({ name: "Ali", district: "", days: [] });
  });
  it("ticks and unticks a day, kept Monday first", () => {
    let v = emptyShortForm();
    v = toggleShortDay(v, 6);
    v = toggleShortDay(v, 2);
    v = toggleShortDay(v, 0);
    expect(v.days).toEqual([2, 6, 0]);
    expect(toggleShortDay(v, 6).days).toEqual([2, 0]);
  });
  it("is sent as name, area and days only", () => {
    expect(toShortPayload({ name: "Ali K", district: "sm1", days: [2, 6] })).toEqual({
      name: "Ali K",
      area: { kind: "district", district: "sm1" },
      days: [2, 6],
    });
  });
});

describe("expanding a short sign-up", () => {
  const short = { name: "Ali K", area: { kind: "district", district: "SM1" }, days: [2, 6], ...TICKS };

  it("is recognised by its days list; a full payload passes through untouched", () => {
    expect(isShortSignup(short)).toBe(true);
    const full = { name: "Ali", availability: [{ day: 2, from: "19:00", to: "22:00" }] };
    expect(isShortSignup(full)).toBe(false);
    expect(expandShortSignup(full)).toBe(full);
    expect(expandShortSignup(null)).toBeNull();
  });

  it("gives each chosen day the whole day, football in any format, 3 miles", () => {
    const r = validatePoolSignup(expandShortSignup(short));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.maxMiles).toBe(3);
    expect(r.value.availability).toEqual([
      { day: 2, fromMin: 0, toMin: 24 * 60 },
      { day: 6, fromMin: 0, toMin: 24 * 60 },
    ]);
    expect(r.value.sports).toEqual([{ sport: "football", otherName: "", formats: [], level: null, levelText: null }]);
  });

  it("ignores anything else a crafted short payload sends for the defaulted fields", () => {
    const r = validatePoolSignup(expandShortSignup({ ...short, maxMiles: 10, sports: [{ sport: "padel" }], availability: [{ day: 1, from: "01:00", to: "02:00" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.maxMiles).toBe(3);
    expect(r.value.availability.map((a) => a.day)).toEqual([2, 6]);
    expect(r.value.sports.map((s) => s.sport)).toEqual(["football"]);
  });

  it("names the days when none is ticked or one is not a day, with the name, area and ticks", () => {
    const none = validatePoolSignup(expandShortSignup({ name: "", area: { kind: "district", district: "" }, days: [] }));
    expect(none).toEqual({ ok: false, errors: { name: "required", area: "district", availability: "none", adult: "required", consent: "required" } });
    const bad = validatePoolSignup(expandShortSignup({ ...short, days: [9] }));
    expect(bad).toEqual({ ok: false, errors: { availability: "bad-day" } });
  });

  it("counts a day ticked twice once", () => {
    const r = validatePoolSignup(expandShortSignup({ ...short, days: [2, 2] }));
    expect(r.ok && r.value.availability).toEqual([{ day: 2, fromMin: 0, toMin: 24 * 60 }]);
  });

  it("is what the public sign-up route validates (English, as every public sign-up)", () => {
    const r = validatePublicPoolSignup({ ...short, language: "tr" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.language).toBe("en");
    expect(r.value.availability).toHaveLength(2);
  });
});
