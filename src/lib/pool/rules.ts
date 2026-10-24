/**
 * THE POOL'S LIMITS AND FIELD RULES (slice L1, 2026-10-24). PURE: no
 * database, no clock of its own.
 *
 * Every number the pool enforces is defined here once. Later slices
 * enforce them (L4 caps and quiet hours, L5 rounds and waves, L7 the
 * pauses, the retention job); none of them may carry its own copy.
 * Approved spec, "Limits" (the doc's plain wording):
 *
 *   At most 2 offers a week and 1 a day per player, none 21:30-08:30. A
 *   round asks up to 8 pool players, about 4 first, the rest only if
 *   places are still open. 3 ignored offers in a row pause the player
 *   until they say they want more. One master switch pauses all pool
 *   offers (`./flags.ts`).
 *
 * The quiet hours are a `QuietHours` value read through
 * `src/lib/message-hours.ts` (`inQuietHours`, `messageHoursSendAfter`), the
 * one module that knows how a window is read. Only the hours are the pool's.
 */
import type { QuietHours } from "../message-hours";

// ── Limits ─────────────────────────────────────────────────────────────

export const POOL_CAPS = Object.freeze({
  /** Offers to one person in any rolling 7 days, across all clubs. */
  perPlayerPerWeek: 2,
  /** Offers to one person per London calendar day. */
  perPlayerPerDay: 1,
  /** Offers to one person per match. Also a unique index on PoolOffer. */
  perPlayerPerMatch: 1,
  /** After a decline, that club cannot offer him again for this many days. */
  declineCooldownDays: 14,
  /** This many ignored offers in a row pause the profile ("ignored"). */
  ignoredInARowPause: 3,
  /** Pool rounds one club may open in any rolling 7 days. */
  roundsPerClubPerWeek: 3,
});

export const POOL_ROUND = Object.freeze({
  /** At most this many offers for one round. */
  maxOffers: 8,
  /** About this many go first ... */
  firstWave: 4,
  /** ... and the rest this long after, only if places are still open. */
  secondWaveAfterMins: 30,
  /** An offer expires this long after it was sent, or at the club's
   *  cut-off, whichever comes first. */
  offerTtlHours: 6,
});

/** No pool DM between 21:30 and 08:30 London. */
export const POOL_QUIET_HOURS: Readonly<QuietHours> = Object.freeze({ enabled: true, from: "21:30", to: "08:30" });

/** How far a player will travel, in miles. */
export const POOL_TRAVEL_MILES = [1, 3, 5, 10] as const;
export type PoolTravelMiles = (typeof POOL_TRAVEL_MILES)[number];
export const DEFAULT_POOL_TRAVEL_MILES: PoolTravelMiles = 3;

/** Minimum age, stated at sign-up and in the policy (decision log #1). */
export const POOL_MIN_AGE = 18;

/** The consent wording's version, stored on each profile with its consent.
 *  Bump it whenever the consent text or the privacy policy changes. */
export const POOL_CONSENT_VERSION = 1;

export const POOL_RETENTION = Object.freeze({
  /** No activity this long: one "still want game offers?" DM. */
  inactiveMonths: 12,
  /** No answer this long after it: the profile ends, personal fields erased. */
  reconfirmGraceDays: 30,
  /** Offer rows keep ids and outcomes only, anonymised after this. */
  offerAnonymiseMonths: 24,
  /** A sign-up never confirmed on WhatsApp is deleted after this. */
  pendingExpiryDays: 7,
});

/** The WhatsApp confirm code: 4 characters from an alphabet with no 0, O,
 *  1, I or L (the ClubConnect code's alphabet), so nobody mistypes it. */
export const POOL_CONFIRM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const POOL_CONFIRM_CODE_LENGTH = 4;

// ── Field rules ────────────────────────────────────────────────────────

/**
 * A UK postcode DISTRICT ("SM1", "SW19", "EC1A"), upper-cased, or null.
 * Never a full postcode: the pool stores the district and its centre point
 * only (plan section 3.3, data held).
 */
export const POSTCODE_DISTRICT_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;

export function normaliseDistrict(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return POSTCODE_DISTRICT_RE.test(s) ? s : null;
}

/** "HH:MM" to minutes after midnight; "24:00" is the end of the day. */
export function parseMinutes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function formatMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** One available stretch: a weekday (0 = Sunday, as `Activity.dayOfWeek`)
 *  and London times, `fromMin` inclusive, `toMin` exclusive. */
export interface AvailabilityRange {
  day: number;
  fromMin: number;
  toMin: number;
}

export type AvailabilityError = "none" | "bad-day" | "bad-time" | "bad-range";

/**
 * The days and hours a player picked, as rows to store: sorted by day and
 * time, overlapping or touching ranges on one day merged. A range never
 * crosses midnight (the form offers 22:00 to 24:00 and 00:00 to 01:00 as
 * two ranges on two days).
 */
export function normaliseAvailability(
  input: ReadonlyArray<{ day: unknown; from: unknown; to: unknown }>,
): { ok: true; value: AvailabilityRange[] } | { ok: false; error: AvailabilityError } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "none" };
  const ranges: AvailabilityRange[] = [];
  for (const r of input) {
    if (typeof r.day !== "number" || !Number.isInteger(r.day) || r.day < 0 || r.day > 6) return { ok: false, error: "bad-day" };
    const fromMin = parseMinutes(r.from);
    const toMin = parseMinutes(r.to);
    if (fromMin === null || toMin === null) return { ok: false, error: "bad-time" };
    if (toMin <= fromMin) return { ok: false, error: "bad-range" };
    ranges.push({ day: r.day, fromMin, toMin });
  }
  ranges.sort((a, b) => a.day - b.day || a.fromMin - b.fromMin);
  const merged: AvailabilityRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last.day === r.day && r.fromMin <= last.toMin) last.toMin = Math.max(last.toMin, r.toMin);
    else merged.push({ ...r });
  }
  return { ok: true, value: merged };
}
