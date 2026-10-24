/**
 * The pool form's state (slice L2): defaults, taps, and the round trip to
 * the payload the validator reads, so what a person ticks is exactly what
 * the server checks and what the manage page shows back.
 */
import { describe, expect, it } from "vitest";
import {
  TIME_OPTIONS,
  addRange,
  addVenue,
  defaultPoolForm,
  fromSavedProfile,
  removeRange,
  removeVenue,
  setRange,
  setSport,
  toPoolPayload,
  toggleDay,
  toggleFormat,
} from "../form-state";
import { validatePoolFields } from "../profile-fields";
import { DEFAULT_POOL_TRAVEL_MILES } from "../rules";

describe("defaults", () => {
  it("football ticked, 3 miles, district, nothing else, consent never pre-ticked (it is not in the state)", () => {
    const v = defaultPoolForm("tr");
    expect(v.sports.football.on).toBe(true);
    expect(Object.entries(v.sports).filter(([, s]) => s.on).map(([k]) => k)).toEqual(["football"]);
    expect(v.maxMiles).toBe(DEFAULT_POOL_TRAVEL_MILES);
    expect(v.areaKind).toBe("district");
    expect(v.language).toBe("tr");
    expect(Object.keys(v)).not.toContain("consent");
  });

  it("time options every half hour to the end of the day", () => {
    expect(TIME_OPTIONS[0]).toBe("00:00");
    expect(TIME_OPTIONS[TIME_OPTIONS.length - 1]).toBe("24:00");
    expect(TIME_OPTIONS).toContain("19:30");
  });
});

describe("days and hours", () => {
  it("ticking a day gives it an evening; unticking clears it", () => {
    let v = toggleDay(defaultPoolForm("en"), 2);
    expect(v.days[2]).toEqual([{ from: "18:00", to: "22:00" }]);
    v = toggleDay(v, 2);
    expect(v.days[2]).toBeUndefined();
  });

  it("several ranges on a day, edited and removed", () => {
    let v = toggleDay(defaultPoolForm("en"), 6);
    v = setRange(v, 6, 0, { from: "09:00", to: "13:00" });
    v = addRange(v, 6);
    expect(v.days[6]).toEqual([{ from: "09:00", to: "13:00" }, { from: "13:00", to: "24:00" }]);
    v = removeRange(v, 6, 0);
    expect(v.days[6]).toEqual([{ from: "13:00", to: "24:00" }]);
    v = removeRange(v, 6, 0);
    expect(v.days[6]).toBeUndefined();
  });
});

describe("sports, formats, levels and pitches", () => {
  it("formats toggle in order", () => {
    expect(toggleFormat([7], 5)).toEqual([5, 7]);
    expect(toggleFormat([5, 7], 5)).toEqual([7]);
  });

  it("pitches are added once and removed", () => {
    let v = addVenue(defaultPoolForm("en"), { id: "v1", name: "Pitch", address: null });
    v = addVenue(v, { id: "v1", name: "Pitch", address: null });
    expect(v.venues).toHaveLength(1);
    expect(removeVenue(v, "v1").venues).toEqual([]);
  });
});

describe("the payload is what the validator reads", () => {
  it("a full form passes the server's validator unchanged", () => {
    let v = defaultPoolForm("en");
    v = { ...v, name: "Ali K", district: "sm1" };
    v = toggleDay(v, 2);
    v = setSport(v, "football", { formats: [7], level: "advanced" });
    v = setSport(v, "padel", { on: true, level: "own", levelText: "keen beginner" });
    v = { ...v, other: { on: true, name: "Ultimate frisbee", formats: [], level: "", levelText: "" } };
    const payload = toPoolPayload(v);
    expect(payload.availability).toEqual([{ day: 2, from: "18:00", to: "22:00" }]);
    const r = validatePoolFields(payload);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sports.map((s) => [s.sport, s.level, s.levelText])).toEqual([
      ["football", "advanced", null],
      ["padel", null, "keen beginner"],
      ["other", null, null],
    ]);
  });

  it("the week goes Monday first in the payload, Sunday last", () => {
    let v = defaultPoolForm("en");
    v = toggleDay(toggleDay(v, 0), 1);
    expect(toPoolPayload(v).availability.map((a) => a.day)).toEqual([1, 0]);
  });

  it("a saved profile comes back as the same form", () => {
    const saved = {
      name: "Ali K",
      area: { kind: "venues" as const, venueIds: ["v1"] },
      venues: [{ id: "v1", name: "Pitch", address: "Road" }],
      maxMiles: 5,
      availability: [
        { day: 2, from: "19:00", to: "22:00" },
        { day: 2, from: "06:00", to: "08:00" },
      ],
      sports: [
        { sport: "basketball" as const, otherName: "", formats: [3], level: "pro" as const, levelText: null },
        { sport: "other" as const, otherName: "Kabaddi", formats: [], level: null, levelText: "rusty" },
      ],
      language: "tr" as const,
    };
    const v = fromSavedProfile(saved);
    expect(v.sports.football.on).toBe(false);
    expect(v.sports.basketball).toEqual({ on: true, formats: [3], level: "pro", levelText: "" });
    expect(v.other).toEqual({ on: true, name: "Kabaddi", formats: [], level: "own", levelText: "rusty" });
    const payload = toPoolPayload(v);
    expect(payload.area).toEqual({ kind: "venues", venueIds: ["v1"] });
    expect(payload.availability).toHaveLength(2);
    expect(validatePoolFields(payload).ok).toBe(true);
  });
});
