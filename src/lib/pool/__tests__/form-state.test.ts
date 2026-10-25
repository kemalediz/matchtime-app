/**
 * The pool form's state (slice L2): defaults, taps, and the round trip to
 * the payload the validator reads, so what a person ticks is exactly what
 * the server checks and what the manage page shows back.
 */
import { describe, expect, it } from "vitest";
import {
  TIME_OPTIONS,
  addRange,
  defaultPoolForm,
  fromSavedProfile,
  removeRange,
  setRange,
  setSport,
  shownSports,
  toPoolPayload,
  toggleDay,
  toggleFormat,
} from "../form-state";
import { validatePoolFields } from "../profile-fields";
import { DEFAULT_POOL_TRAVEL_MILES } from "../rules";
import { POOL_SPORT_KEYS, type LiveSports } from "../sports";

const ALL: { live: LiveSports } = { live: { sports: POOL_SPORT_KEYS, other: true } };

describe("defaults", () => {
  it("football ticked, 3 miles, district, nothing else, consent never pre-ticked (it is not in the state)", () => {
    const v = defaultPoolForm("tr");
    expect(v.sports.football.on).toBe(true);
    expect(Object.entries(v.sports).filter(([, s]) => s.on).map(([k]) => k)).toEqual(["football"]);
    expect(v.maxMiles).toBe(DEFAULT_POOL_TRAVEL_MILES);
    expect(v.district).toBe("");
    expect(v).not.toHaveProperty("areaKind");
    expect(v).not.toHaveProperty("venues");
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

describe("sports, formats and levels", () => {
  it("formats toggle in order", () => {
    expect(toggleFormat([7], 5)).toEqual([5, 7]);
    expect(toggleFormat([5, 7], 5)).toEqual([7]);
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
    const r = validatePoolFields(payload, ALL);
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
      area: { kind: "district" as const, district: "SW19" },
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
    expect(payload.area).toEqual({ kind: "district", district: "SW19" });
    expect(payload.availability).toHaveLength(2);
    expect(validatePoolFields(payload, ALL).ok).toBe(true);
    // Neither is live today: the manage page keeps them because they are saved.
    expect(validatePoolFields(payload).ok).toBe(false);
    expect(validatePoolFields(payload, { keep: ["basketball:", "other:kabaddi"] }).ok).toBe(true);
  });
});

describe("shownSports: the rows the form shows", () => {
  it("a new form: the live sports only, and one live sport is shown without a tick box", () => {
    expect(shownSports(defaultPoolForm("en"))).toEqual({ sports: ["football"], other: false, single: true });
  });

  it("a live switch with more sports shows each with its tick box, and Other when it is on", () => {
    const live: LiveSports = { sports: ["football", "basketball"], other: true };
    expect(shownSports(defaultPoolForm("en"), live)).toEqual({ sports: ["football", "basketball"], other: true, single: false });
  });

  it("a saved sport that is no longer live is still shown, so he sees it and can untick it", () => {
    const v = setSport(defaultPoolForm("en"), "padel", { on: true });
    expect(shownSports(v)).toEqual({ sports: ["football", "padel"], other: false, single: false });
    const w = { ...defaultPoolForm("en"), other: { on: true, name: "Kabaddi", formats: [], level: "" as const, levelText: "" } };
    expect(shownSports(w)).toEqual({ sports: ["football"], other: true, single: false });
  });

  it("one live sport shown alone is always sent, even if its state was off", () => {
    const v = setSport(defaultPoolForm("en"), "football", { on: false, formats: [7] });
    expect(toPoolPayload(v).sports).toEqual([{ sport: "football", formats: [7], level: null, levelText: null }]);
  });
});
