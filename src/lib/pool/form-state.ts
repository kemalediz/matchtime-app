/**
 * The pool form's state in the browser (slice L2). PURE and CLIENT-SAFE.
 *
 * The /play sign-up and the manage page edit the same fields with the same
 * component; this is the one model of what the form holds, how each tap
 * changes it, and how it becomes the payload `profile-fields.ts` checks.
 * The form never decides what is valid: it sends, and shows what the
 * validator said (the same validator runs in the browser first, for speed,
 * and on the server, for truth).
 */
import type { Lang } from "../i18n/lang";
import { DEFAULT_POOL_TRAVEL_MILES, formatMinutes } from "./rules";
import { DEFAULT_POOL_SPORT, OTHER_SPORT, POOL_SPORT_KEYS, type PoolSportChoiceKey, type PoolSportKey, type SportLevel } from "./sports";

export interface PoolVenueChoice {
  id: string;
  name: string;
  address: string | null;
}

/** "" not saying; a catalogue level; "own" his own words in `levelText`. */
export type LevelChoice = SportLevel | "" | "own";

export interface SportState {
  on: boolean;
  formats: number[];
  level: LevelChoice;
  levelText: string;
}

export interface PoolFormValue {
  name: string;
  areaKind: "district" | "venues";
  district: string;
  venues: PoolVenueChoice[];
  maxMiles: number;
  /** By weekday (0 = Sunday); a day is ticked when it has ranges. */
  days: Partial<Record<number, Array<{ from: string; to: string }>>>;
  sports: Record<PoolSportKey, SportState>;
  other: SportState & { name: string };
  language: Lang;
}

/** Every half hour of the day, "00:00" to "24:00", for the time pickers. */
export const TIME_OPTIONS: readonly string[] = Array.from({ length: 49 }, (_, i) => formatMinutes(i * 30));

/** A newly ticked day starts with an evening. */
export const DEFAULT_RANGE = Object.freeze({ from: "18:00", to: "22:00" });

/** Monday first, as people read a week; values are `Activity.dayOfWeek`. */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

const emptySport = (): SportState => ({ on: false, formats: [], level: "", levelText: "" });

export function defaultPoolForm(language: Lang): PoolFormValue {
  const sports = Object.fromEntries(POOL_SPORT_KEYS.map((k) => [k, emptySport()])) as Record<PoolSportKey, SportState>;
  sports[DEFAULT_POOL_SPORT] = { ...sports[DEFAULT_POOL_SPORT], on: true };
  return {
    name: "",
    areaKind: "district",
    district: "",
    venues: [],
    maxMiles: DEFAULT_POOL_TRAVEL_MILES,
    days: {},
    sports,
    other: { ...emptySport(), name: "" },
    language,
  };
}

// ── Taps ───────────────────────────────────────────────────────────────

export function toggleDay(v: PoolFormValue, day: number): PoolFormValue {
  const days = { ...v.days };
  if (days[day]?.length) delete days[day];
  else days[day] = [{ ...DEFAULT_RANGE }];
  return { ...v, days };
}

export function addRange(v: PoolFormValue, day: number): PoolFormValue {
  const ranges = v.days[day] ?? [];
  const last = ranges[ranges.length - 1];
  const next = last && last.to !== "24:00" ? { from: last.to, to: "24:00" } : { ...DEFAULT_RANGE };
  return { ...v, days: { ...v.days, [day]: [...ranges, next] } };
}

export function removeRange(v: PoolFormValue, day: number, index: number): PoolFormValue {
  const ranges = (v.days[day] ?? []).filter((_, i) => i !== index);
  const days = { ...v.days };
  if (ranges.length) days[day] = ranges;
  else delete days[day];
  return { ...v, days };
}

export function setRange(v: PoolFormValue, day: number, index: number, patch: Partial<{ from: string; to: string }>): PoolFormValue {
  const ranges = (v.days[day] ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r));
  return { ...v, days: { ...v.days, [day]: ranges } };
}

export function setSport(v: PoolFormValue, key: PoolSportKey, patch: Partial<SportState>): PoolFormValue {
  return { ...v, sports: { ...v.sports, [key]: { ...v.sports[key], ...patch } } };
}

export function toggleFormat(formats: readonly number[], n: number): number[] {
  return formats.includes(n) ? formats.filter((f) => f !== n) : [...formats, n].sort((a, b) => a - b);
}

export function addVenue(v: PoolFormValue, venue: PoolVenueChoice): PoolFormValue {
  if (v.venues.some((x) => x.id === venue.id)) return v;
  return { ...v, venues: [...v.venues, venue] };
}

export function removeVenue(v: PoolFormValue, id: string): PoolFormValue {
  return { ...v, venues: v.venues.filter((x) => x.id !== id) };
}

// ── To and from the server ─────────────────────────────────────────────

const levelOf = (s: SportState) => ({
  level: s.level && s.level !== "own" ? s.level : null,
  levelText: s.level === "own" ? s.levelText : null,
});

/** The fields as `validatePoolFields` reads them. */
export function toPoolPayload(v: PoolFormValue) {
  const sports: Array<{ sport: PoolSportChoiceKey; otherName?: string; formats: number[]; level: SportLevel | null; levelText: string | null }> = [];
  for (const key of POOL_SPORT_KEYS) {
    const s = v.sports[key];
    if (s.on) sports.push({ sport: key, formats: s.formats, ...levelOf(s) });
  }
  if (v.other.on) sports.push({ sport: OTHER_SPORT, otherName: v.other.name, formats: [], ...levelOf(v.other) });
  return {
    name: v.name,
    area: v.areaKind === "district" ? { kind: "district" as const, district: v.district } : { kind: "venues" as const, venueIds: v.venues.map((x) => x.id) },
    maxMiles: v.maxMiles,
    availability: WEEK_ORDER.flatMap((day) => (v.days[day] ?? []).map((r) => ({ day, from: r.from, to: r.to }))),
    sports,
    language: v.language,
  };
}

/** What the manage page loaded, as the form's state. */
export function fromSavedProfile(saved: {
  name: string;
  area: { kind: "district"; district: string } | { kind: "venues"; venueIds: string[] };
  venues: PoolVenueChoice[];
  maxMiles: number;
  availability: Array<{ day: number; from: string; to: string }>;
  sports: Array<{ sport: PoolSportChoiceKey; otherName: string; formats: number[]; level: SportLevel | null; levelText: string | null }>;
  language: Lang;
}): PoolFormValue {
  const v = defaultPoolForm(saved.language);
  v.sports[DEFAULT_POOL_SPORT] = emptySport();
  const days: PoolFormValue["days"] = {};
  for (const a of saved.availability) days[a.day] = [...(days[a.day] ?? []), { from: a.from, to: a.to }];
  const asState = (s: (typeof saved.sports)[number]): SportState => ({
    on: true,
    formats: s.formats,
    level: s.levelText ? "own" : (s.level ?? ""),
    levelText: s.levelText ?? "",
  });
  for (const s of saved.sports) {
    if (s.sport === OTHER_SPORT) v.other = { ...asState(s), name: s.otherName };
    else v.sports[s.sport] = asState(s);
  }
  return {
    ...v,
    name: saved.name,
    areaKind: saved.area.kind,
    district: saved.area.kind === "district" ? saved.area.district : "",
    venues: saved.venues,
    maxMiles: saved.maxMiles,
    days,
  };
}
