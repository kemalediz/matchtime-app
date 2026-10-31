/**
 * THE POOL'S LIMITS AND FIELD RULES (slice L1, 2026-10-24). PURE: no
 * database, no clock of its own.
 *
 * Every number the pool enforces is defined here once. Later slices
 * enforce them (L4 caps, L5 rounds and waves, L7 the
 * pauses, the retention job); none of them may carry its own copy.
 * Approved spec, "Limits" (the doc's plain wording):
 *
 *   At most 2 offers a week and 1 a day per player. A
 *   round asks up to 8 pool players, about 4 first, the rest only if
 *   places are still open. 3 ignored offers in a row pause the player
 *   until they say they want more. One master switch pauses all pool
 *   offers (`./flags.ts`).
 *
 * NO NIGHT HOLD (Kemal, 2026-10-29: "I would remove this quiet hours for
 * now"). The pool had its own hard-coded 21:30 to 08:30 hold on every pool
 * DM; it is gone for every ask, the organiser's and the automatic one, with
 * no setting in its place. A pool DM goes when it is made. Every cap above
 * still holds. The club's own quiet hours (`message-hours.ts`) are a
 * different rule and are unchanged.
 */
import { PRIVACY_POLICY_VERSION } from "../privacy-policy";
import type { GeocodeHit } from "../geocode";

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

/** How far a player will travel, in miles. */
export const POOL_TRAVEL_MILES = [1, 3, 5, 10] as const;
export type PoolTravelMiles = (typeof POOL_TRAVEL_MILES)[number];
export const DEFAULT_POOL_TRAVEL_MILES: PoolTravelMiles = 3;

/** Minimum age, stated at sign-up and in the policy (decision log #1). */
export const POOL_MIN_AGE = 18;

/** The consent wording's version, stored on each profile with its consent:
 *  the privacy policy's version (src/lib/privacy-policy.ts), ONE number,
 *  so the policy a player agreed to and the consent record never disagree
 *  (slice L2). Bump PRIVACY_POLICY_VERSION when either text changes. */
export const POOL_CONSENT_VERSION = PRIVACY_POLICY_VERSION;

export const POOL_RETENTION = Object.freeze({
  /** No activity this long: one "still want game offers?" DM. */
  inactiveMonths: 12,
  /** No answer this long after it: the profile ends, personal fields erased. */
  reconfirmGraceDays: 30,
  /** Offer rows keep ids and outcomes only, anonymised after this. */
  offerAnonymiseMonths: 24,
  /** A sign-up never confirmed on WhatsApp is deleted after this (the
   *  daily housekeeping, `housekeeping.ts`). */
  pendingExpiryDays: 7,
  /** The consent record (consents and withdrawals) is kept this long, also
   *  after the profile is deleted, to show what was agreed (decision L0.3). */
  consentRecordYears: 6,
});

/**
 * Confirming a sign-up on WhatsApp (slice L2, `confirm-rules.ts`).
 *   codeTtlDays       a /play code works this long. The waiting sign-up
 *                     lives longer (POOL_RETENTION.pendingExpiryDays), so a
 *                     late message still hears "that code has expired".
 *   wrongCodesPerDay  a number that sent this many wrong or expired codes
 *                     in 24 hours has every further code ignored, a right
 *                     one too, until the 24 hours pass (guessing codes).
 *   replyThrottleMins at most one "that code did not work" reply per number
 *   repliesPerDay     this often, and this many in 24 hours.
 *   attemptKeepDays   failed attempts are kept this long, for the two rules
 *                     above, then deleted.
 */
export const POOL_CONFIRM = Object.freeze({
  codeTtlDays: 3,
  wrongCodesPerDay: 5,
  replyThrottleMins: 10,
  repliesPerDay: 3,
  attemptKeepDays: 30,
});

/**
 * The /play form (slice L2).
 *   perIpPerHour       sign-up ATTEMPTS one requesting address may make an
 *                      hour, whatever their result (each may cost a paid
 *                      geocoding call). 20, not 5: mobile networks put many
 *                      people behind one address (carrier NAT).
 *   maxSports, maxRanges   what one profile may hold.
 *   nameMax            the name as typed, at most this long.
 */
export const POOL_SIGNUP = Object.freeze({
  perIpPerHour: 20,
  maxSports: 12,
  maxRanges: 21,
  nameMax: 40,
});

/**
 * The /play reminder's status check (2026-10-31, `signup-status.ts`): a
 * browser that signed up asks whether its sign-up still waits for the code.
 *   perIpPerHour   checks one requesting address may make an hour, whatever
 *                  the answer. A returning visitor makes one per visit, so
 *                  this is generous for carrier NAT and still stops a flood.
 *                  Counted in the server's memory, not in PoolAttempt: the
 *                  signed token already makes guessing pointless (a forged
 *                  one never reaches the database), so the cap only guards
 *                  load, and a new PoolAttempt kind would need a migration.
 */
export const POOL_SIGNUP_STATUS = Object.freeze({
  perIpPerHour: 60,
});

/** The WhatsApp confirm code: from an alphabet with no 0, O, 1, I or L (the
 *  ClubConnect code's alphabet), so nobody mistypes it. FIVE characters
 *  (slice L2), where a self-join connect code has four: the two readers
 *  each take only their own length, so a pool code can never be read as a
 *  connect code or the other way round, whatever words surround it. */
export const POOL_CONFIRM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const POOL_CONFIRM_CODE_LENGTH = 5;

// ── Field rules ────────────────────────────────────────────────────────

/**
 * A UK postcode DISTRICT ("SM1", "SW19", "EC1A"), upper-cased, or null.
 * Never a full postcode: the pool stores the district and its centre point
 * only (plan section 3.3, data held).
 */
export const POSTCODE_DISTRICT_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;

/**
 * Is this Google result a UK postcode area we may store as his centre
 * point (slice L2)? Only a postcode or postcode-area result, matched whole,
 * in the UK: never a country, a town, or a partial match, which would put
 * him miles from where he plays.
 */
export function acceptDistrictGeocode(hit: Pick<GeocodeHit, "types" | "partialMatch" | "countryCode">): boolean {
  if (hit.countryCode !== "GB" || hit.partialMatch) return false;
  return hit.types.includes("postal_code_prefix") || hit.types.includes("postal_code");
}

/** Waiting sign-ups made before this are deleted (the daily housekeeping). */
export function pendingSignupPurgeBefore(now: Date): Date {
  return new Date(now.getTime() - POOL_RETENTION.pendingExpiryDays * 24 * 60 * 60 * 1000);
}

export function normaliseDistrict(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return POSTCODE_DISTRICT_RE.test(s) ? s : null;
}

/**
 * WHERE A POOL PLAYER PLAYS (2026-10-25): a postcode district, and how far
 * he travels from its centre (`maxMiles`, one of POOL_TRAVEL_MILES). That is
 * the whole idea of "where": there are no chosen pitches. A district is the
 * only kind today; another kind of area would be one more member of this
 * union, read by `profile-fields.ts` and placed by `profile-store.ts`.
 */
export type PoolArea = { kind: "district"; district: string };

/** A full UK postcode inside an address ("SM1 2EY", "sm12ey"). */
const FULL_POSTCODE_IN_ADDRESS = /\b([A-Z]{1,2}[0-9][A-Z0-9]?)\s*[0-9][A-Z]{2}\b/gi;

/**
 * The postcode district of a pitch's address, as Google formats it
 * (`Venue.formattedAddress`, "Gander Green Ln, Sutton SM1 2EY, UK"): the
 * first half of the last full UK postcode in it. Null when there is no full
 * postcode, never a guess. Only for addresses Google wrote, never for what
 * people type.
 */
export function districtOfAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const all = [...address.matchAll(FULL_POSTCODE_IN_ADDRESS)];
  const last = all[all.length - 1];
  return last ? normaliseDistrict(last[1]) : null;
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
