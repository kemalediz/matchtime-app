/**
 * The /play sign-up's unsent draft (Kemal, 2026-10-27). CLIENT-SAFE.
 *
 * What he typed into the form, and nothing else (never the two ticks: he
 * agrees afresh each time), kept in this tab's sessionStorage so a reload or
 * a back navigation loses nothing. Storage is a convenience: every read and
 * write is wrapped, a blocked or empty store just means a fresh form, and a
 * sent sign-up clears it. What comes back is read defensively, field by
 * field, onto a fresh form; the validator still runs on send.
 */
import { isLang } from "../i18n/lang";
import type { PoolFormValue, SportState } from "./form-state";

export const SIGNUP_DRAFT_KEY = "mt.pool.signupDraft.v1";

const MAX_NAME = 200;
const MAX_DISTRICT = 40;
const MAX_TEXT = 200;

export function encodeSignupDraft(v: PoolFormValue): string {
  const { name, district, maxMiles, days, sports, other, language } = v;
  return JSON.stringify({ v: 1, form: { name, district, maxMiles, days, sports, other, language } });
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, max: number, fallback: string) => (typeof x === "string" ? x.slice(0, max) : fallback);

function sport(x: unknown, base: SportState): SportState {
  if (!isObj(x)) return base;
  return {
    on: typeof x.on === "boolean" ? x.on : base.on,
    formats: Array.isArray(x.formats) ? x.formats.filter((n): n is number => typeof n === "number" && Number.isInteger(n)).slice(0, 20) : base.formats,
    level: (typeof x.level === "string" ? x.level.slice(0, 40) : base.level) as SportState["level"],
    levelText: str(x.levelText, MAX_TEXT, base.levelText),
  };
}

function days(x: unknown): PoolFormValue["days"] {
  if (!isObj(x)) return {};
  const out: PoolFormValue["days"] = {};
  for (const [k, ranges] of Object.entries(x)) {
    const day = Number(k);
    if (!Number.isInteger(day) || day < 0 || day > 6 || !Array.isArray(ranges)) continue;
    const ok = ranges
      .filter((r): r is { from: string; to: string } => isObj(r) && typeof r.from === "string" && typeof r.to === "string")
      .slice(0, 10)
      .map((r) => ({ from: r.from.slice(0, 5), to: r.to.slice(0, 5) }));
    if (ok.length) out[day] = ok;
  }
  return out;
}

/** The draft onto `base` (a fresh form), or null when there is none. */
export function decodeSignupDraft(raw: string | null, base: PoolFormValue): PoolFormValue | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed) || parsed.v !== 1 || !isObj(parsed.form)) return null;
  const f = parsed.form;
  const sports = Object.fromEntries(
    Object.entries(base.sports).map(([k, b]) => [k, sport(isObj(f.sports) ? f.sports[k] : undefined, b)]),
  ) as PoolFormValue["sports"];
  const other = isObj(f.other) ? { ...sport(f.other, base.other), name: str(f.other.name, MAX_TEXT, base.other.name) } : base.other;
  return {
    name: str(f.name, MAX_NAME, base.name),
    district: str(f.district, MAX_DISTRICT, base.district),
    maxMiles: typeof f.maxMiles === "number" && Number.isFinite(f.maxMiles) ? f.maxMiles : base.maxMiles,
    days: days(f.days),
    sports,
    other,
    language: isLang(f.language) ? f.language : base.language,
  };
}

// ── The browser's store (never required to work) ───────────────────────

export function loadSignupDraft(base: PoolFormValue): PoolFormValue | null {
  try {
    return decodeSignupDraft(window.sessionStorage.getItem(SIGNUP_DRAFT_KEY), base);
  } catch {
    return null;
  }
}

export function saveSignupDraft(v: PoolFormValue): void {
  try {
    window.sessionStorage.setItem(SIGNUP_DRAFT_KEY, encodeSignupDraft(v));
  } catch {
    // Blocked or full: he just keeps nothing.
  }
}

export function clearSignupDraft(): void {
  try {
    window.sessionStorage.removeItem(SIGNUP_DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}
