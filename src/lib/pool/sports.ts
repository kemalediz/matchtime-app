/**
 * THE POOL'S SPORT CATALOGUE (slice L1, 2026-10-24). PURE.
 *
 * The ONE place that says which sports a pool player can pick, which have
 * formats (and which), the level scale, and every label in every language.
 * The /play form, matching (L4) and the offer copy (L5) all read it; the DB
 * CHECK on `PoolSport` is pinned to it by `__tests__/schema-sql.test.ts`.
 *
 * Approved spec (Kemal, 2026-10-24): any sport played by hiring a venue with
 * mates; football ticked by default; "Other" lets the player type one in.
 * Formats only where the sport has them: football 5, 7, 8, 9 or 11-a-side,
 * basketball 3 or 5-a-side. Level per sport is optional: Novice,
 * Intermediate, Advanced or Pro, or the player's own words.
 *
 * WHY THE LABELS LIVE HERE, NOT IN src/lib/i18n: they are catalogue data
 * with one entry per sport, and the string tables refuse a Turkish entry
 * equal to the English one, which "Badminton" and "Padel" honestly are.
 * `Record<Lang, string>` keeps the "every language or tsc fails" rule.
 *
 * NOT the club's sport presets (`src/lib/sport-presets.ts`): those describe
 * how a club runs its own game (positions, team labels, balancing).
 * `poolSportOfClubSport` is the one bridge from a club's Sport row to this
 * catalogue.
 */
import type { Lang } from "../i18n/lang";
import { SPORT_PRESETS, type SportPreset } from "../sport-presets";

export interface PoolSportDef {
  key: string;
  /** Players per side the player may pick; empty when the sport has none. */
  formats: readonly number[];
  label: Readonly<Record<Lang, string>>;
}

export const POOL_SPORTS = [
  { key: "football", formats: [5, 7, 8, 9, 11], label: { en: "Football", tr: "Futbol" } },
  { key: "basketball", formats: [3, 5], label: { en: "Basketball", tr: "Basketbol" } },
  { key: "tennis", formats: [], label: { en: "Tennis", tr: "Tenis" } },
  { key: "badminton", formats: [], label: { en: "Badminton", tr: "Badminton" } },
  { key: "squash", formats: [], label: { en: "Squash", tr: "Squash" } },
  { key: "padel", formats: [], label: { en: "Padel", tr: "Padel" } },
  { key: "table-tennis", formats: [], label: { en: "Table tennis", tr: "Masa tenisi" } },
  { key: "billiards", formats: [], label: { en: "Billiards", tr: "Bilardo" } },
  { key: "snooker", formats: [], label: { en: "Snooker", tr: "Snooker" } },
  { key: "pool", formats: [], label: { en: "Pool", tr: "Amerikan bilardosu" } },
] as const satisfies readonly PoolSportDef[];

export type PoolSportKey = (typeof POOL_SPORTS)[number]["key"];

export const POOL_SPORT_KEYS: readonly PoolSportKey[] = POOL_SPORTS.map((s) => s.key);

// ── WHICH SPORTS ARE LIVE: THE ONE SWITCH (Kemal, 2026-10-25) ──────────
//
// "Let's focus on football for now ... we can extend to other sports but
// keep it easily extendable." The catalogue above stays whole; this says
// which of it is offered. The website copy (landing-content.ts), the /play
// form and the member opt-in (form-state.ts `shownSports`), the server
// validation (profile-fields.ts) and the public-copy guard
// (src/app/__tests__/public-copy.test.ts) all read it.
//
// Club setup reads it too (Kemal, 2026-10-25): the web onboarding wizard,
// the admin activities picker, the in-group WhatsApp setup and self-join
// only offer the club sport presets (src/lib/sport-presets.ts) whose pool
// sport is live (`isLivePreset` below, through `PRESET_TO_POOL`). A preset
// with no pool sport (netball, volleyball, cricket) is never live until a
// mapping is added. A club that already plays a sport keeps it.
//
// To switch a sport on, add its key to `sports` (and `other: true` brings
// back the typed-in "Other"). Then reword any website line that says the
// sport in plain words (landing-content.ts `SITE_META`, `HERO`). The chips,
// the pool card, the form, the validation and club setup follow by
// themselves.

export interface LiveSports {
  readonly sports: readonly PoolSportKey[];
  /** Whether the typed-in "Other" sport is offered. */
  readonly other: boolean;
}

export const LIVE_SPORTS: LiveSports = { sports: ["football"], other: false };

/** Offered right now: a live catalogue sport, or "other" when it is on. */
export function isLiveSport(key: string, live: LiveSports = LIVE_SPORTS): boolean {
  if (key === OTHER_SPORT) return live.other;
  return isPoolSportKey(key) && live.sports.includes(key);
}

/** The live catalogue entries, in catalogue order. */
export function liveSports(live: LiveSports = LIVE_SPORTS): readonly PoolSportDef[] {
  return (POOL_SPORTS as readonly PoolSportDef[]).filter((s) => isLiveSport(s.key, live));
}

/** A club sport preset whose pool sport is live (futsal is football). */
export function isLivePreset(key: string, live: LiveSports = LIVE_SPORTS): boolean {
  const pool = PRESET_TO_POOL[key];
  return !!pool && isLiveSport(pool.sport, live);
}

/** The club sport presets a new club may pick, in the library's order. */
export function liveSportPresets(live: LiveSports = LIVE_SPORTS): readonly SportPreset[] {
  return SPORT_PRESETS.filter((p) => isLivePreset(p.key, live));
}

/**
 * The live preset for `n` players per side: football's n-a-side first,
 * else any live preset of that size, in the library's order. None when no
 * live preset has that size (the caller builds a plain sport instead).
 */
export function livePresetForSide(n: number, live: LiveSports = LIVE_SPORTS): SportPreset | undefined {
  const presets = liveSportPresets(live);
  return presets.find((p) => p.key === `football-${n}aside`) ?? presets.find((p) => p.playersPerTeam === n);
}

/**
 * Whether one of a club's own Sport rows may carry a NEW weekly game: its
 * sport is live, or the club already plays it (`inUse`: an existing club
 * keeps its sport). A preset that is not a live pool sport is not offered;
 * a custom sport is judged by its name, and a name that is no catalogue
 * sport at all is the club's own and stays offered.
 */
export function isOfferedClubSport(
  sport: { preset: string | null; name: string; playersPerTeam: number },
  opts: { inUse?: boolean } = {},
  live: LiveSports = LIVE_SPORTS,
): boolean {
  if (opts.inUse) return true;
  if (sport.preset) return isLivePreset(sport.preset, live);
  const pool = poolSportOfClubSport(sport);
  return !pool || isLiveSport(pool.sport, live);
}

/** Words that are only ever the name of a sport the pool does not offer. */
const NOT_A_SPORT_NAME = new Set(["pool"]); // also the player pool itself

/**
 * Every catalogue sport that is not live, by its name in every language,
 * lower case: what the public pages must not name. "Pool" is left out,
 * as it is also the word for the player pool.
 */
export function notLiveSportNames(live: LiveSports = LIVE_SPORTS): string[] {
  const names = (POOL_SPORTS as readonly PoolSportDef[])
    .filter((s) => !isLiveSport(s.key, live))
    .flatMap((s) => Object.values(s.label).map((l) => l.toLowerCase()))
    .filter((n) => !NOT_A_SPORT_NAME.has(n));
  return [...new Set(names)];
}

/** One key per sport on a profile ("other" by its name, case-blind). */
export function sportChoiceKey(c: { sport: string; otherName: string }): string {
  return `${c.sport}:${c.otherName.trim().toLowerCase()}`;
}

/** Ticked by default on the form. */
export const DEFAULT_POOL_SPORT: PoolSportKey = "football";

/** A sport the player typed in himself; its name is `otherName`. */
export const OTHER_SPORT = "other";
export type PoolSportChoiceKey = PoolSportKey | typeof OTHER_SPORT;

const OTHER_LABEL: Readonly<Record<Lang, string>> = { en: "Other", tr: "Diğer" };

/** An `otherName` / `levelText` is at most this long. */
export const POOL_FREE_TEXT_MAX = 40;

export const SPORT_LEVELS = ["novice", "intermediate", "advanced", "pro"] as const;
export type SportLevel = (typeof SPORT_LEVELS)[number];

const LEVEL_LABELS: Readonly<Record<SportLevel, Readonly<Record<Lang, string>>>> = {
  novice: { en: "Novice", tr: "Yeni başlayan" },
  intermediate: { en: "Intermediate", tr: "Orta" },
  advanced: { en: "Advanced", tr: "İleri" },
  pro: { en: "Pro", tr: "Profesyonel" },
};

export function isPoolSportKey(v: unknown): v is PoolSportKey {
  return typeof v === "string" && (POOL_SPORT_KEYS as readonly string[]).includes(v);
}

const defOf = (key: string): PoolSportDef | undefined => (POOL_SPORTS as readonly PoolSportDef[]).find((s) => s.key === key);

/** The formats a sport offers; none for "other" or an unknown key. */
export function formatsOf(key: string): readonly number[] {
  return defOf(key)?.formats ?? [];
}

export function sportHasFormats(key: string): boolean {
  return formatsOf(key).length > 0;
}

/** The sport's name in `lang` ("Other" for "other"). */
export function sportLabel(key: PoolSportChoiceKey, lang: Lang): string {
  return key === OTHER_SPORT ? OTHER_LABEL[lang] : (defOf(key)?.label[lang] ?? key);
}

export function levelLabel(level: SportLevel, lang: Lang): string {
  return LEVEL_LABELS[level][lang];
}

/** One sport as a profile stores it (a `PoolSport` row's fields). */
export interface PoolSportChoice {
  sport: PoolSportChoiceKey;
  /** The typed-in name for "other"; "" for a catalogue sport. */
  otherName: string;
  level: SportLevel | null;
  levelText: string | null;
  formats: number[];
}

export type SportChoiceError = "bad-sport" | "other-needs-name" | "bad-format" | "bad-level";

const freeText = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length > 0 && s.length <= POOL_FREE_TEXT_MAX ? s : null;
};

/** What the form may save for one sport, or why not. */
export function normaliseSportChoice(input: {
  sport: unknown;
  otherName?: unknown;
  formats?: unknown;
  level?: unknown;
  levelText?: unknown;
}): { ok: true; value: PoolSportChoice } | { ok: false; error: SportChoiceError } {
  const sport = input.sport;
  if (sport !== OTHER_SPORT && !isPoolSportKey(sport)) return { ok: false, error: "bad-sport" };

  let otherName = "";
  if (sport === OTHER_SPORT) {
    const name = freeText(input.otherName);
    if (!name) return { ok: false, error: "other-needs-name" };
    otherName = name;
  }

  const raw = Array.isArray(input.formats) ? input.formats : [];
  const allowed = formatsOf(sport);
  if (!raw.every((f) => typeof f === "number" && allowed.includes(f))) return { ok: false, error: "bad-format" };
  const formats = [...new Set(raw as number[])].sort((a, b) => a - b);

  const hasLevel = input.level !== undefined && input.level !== null && input.level !== "";
  const hasText = typeof input.levelText === "string" && input.levelText.trim() !== "";
  if (hasLevel && hasText) return { ok: false, error: "bad-level" };
  if (hasLevel && !(SPORT_LEVELS as readonly unknown[]).includes(input.level)) return { ok: false, error: "bad-level" };
  const levelText = hasText ? freeText(input.levelText) : null;
  if (hasText && !levelText) return { ok: false, error: "bad-level" };

  return {
    ok: true,
    value: { sport, otherName, level: hasLevel ? (input.level as SportLevel) : null, levelText, formats },
  };
}

/** The club sport presets that are a pool sport, and their format. */
const PRESET_TO_POOL: Readonly<Record<string, { sport: PoolSportKey; format: number }>> = {
  "football-5aside": { sport: "football", format: 5 },
  futsal: { sport: "football", format: 5 },
  "football-7aside": { sport: "football", format: 7 },
  "football-8aside": { sport: "football", format: 8 },
  "football-9aside": { sport: "football", format: 9 },
  "football-11aside": { sport: "football", format: 11 },
  "basketball-3v3": { sport: "basketball", format: 3 },
  "basketball-5v5": { sport: "basketball", format: 5 },
};

/**
 * Which pool sport, and which format, a club's game is. The preset decides
 * when there is one; a custom sport is matched by its name's first word
 * against the catalogue, its format by its players per team (null when that
 * is not one of the sport's formats). Null: the pool has no such sport.
 */
export function poolSportOfClubSport(sport: {
  preset: string | null;
  name: string;
  playersPerTeam: number;
}): { sport: PoolSportKey; format: number | null } | null {
  if (sport.preset && PRESET_TO_POOL[sport.preset]) return PRESET_TO_POOL[sport.preset];
  if (sport.preset) return null;
  const name = sport.name.trim().toLowerCase();
  const def = (POOL_SPORTS as readonly PoolSportDef[]).find((s) => {
    const label = s.label.en.toLowerCase();
    return name === label || name.startsWith(`${label} `) || name.startsWith(`${s.key} `);
  });
  if (!def) return null;
  return { sport: def.key as PoolSportKey, format: def.formats.includes(sport.playersPerTeam) ? sport.playersPerTeam : null };
}
