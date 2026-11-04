/**
 * The /play sign-up's unsent draft (Kemal, 2026-10-27). CLIENT-SAFE.
 *
 * What he typed into the form, and nothing else (never the two ticks: he
 * agrees afresh each time), kept in this tab's sessionStorage so a reload or
 * a back navigation loses nothing. Storage is a convenience: every read and
 * write is wrapped, a blocked or empty store just means a fresh form, and a
 * sent sign-up clears it. What comes back is read defensively, field by
 * field, onto a fresh form; the validator still runs on send.
 *
 * The short form (2026-11-04, `short-form.ts`): his name, postcode area and
 * days. The key is new (v2), so a draft of the long form is not read.
 */
import { toggleShortDay, type ShortFormValue } from "./short-form";

export const SIGNUP_DRAFT_KEY = "mt.pool.signupDraft.v2";

const MAX_NAME = 200;
const MAX_DISTRICT = 40;

export function encodeSignupDraft(v: ShortFormValue): string {
  const { name, district, days } = v;
  return JSON.stringify({ v: 2, form: { name, district, days } });
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, max: number, fallback: string) => (typeof x === "string" ? x.slice(0, max) : fallback);

/** The draft onto `base` (a fresh form), or null when there is none. */
export function decodeSignupDraft(raw: string | null, base: ShortFormValue): ShortFormValue | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed) || parsed.v !== 2 || !isObj(parsed.form)) return null;
  const f = parsed.form;
  let v: ShortFormValue = { name: str(f.name, MAX_NAME, base.name), district: str(f.district, MAX_DISTRICT, base.district), days: [] };
  const days = Array.isArray(f.days) ? f.days : [];
  for (const d of days) {
    if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6 && !v.days.includes(d)) v = toggleShortDay(v, d);
  }
  return v;
}

// ── The browser's store (never required to work) ───────────────────────

export function loadSignupDraft(base: ShortFormValue): ShortFormValue | null {
  try {
    return decodeSignupDraft(window.sessionStorage.getItem(SIGNUP_DRAFT_KEY), base);
  } catch {
    return null;
  }
}

export function saveSignupDraft(v: ShortFormValue): void {
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
