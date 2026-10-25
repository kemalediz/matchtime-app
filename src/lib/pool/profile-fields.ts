/**
 * A POOL PROFILE'S FIELDS, as the /play form and the manage page send them
 * (slice L2, 2026-10-24). PURE and CLIENT-SAFE: no database, no server
 * import, so the form can show the same errors the server enforces.
 *
 * ONE validator for both pages: sign-up is `validatePoolFields` plus the
 * two ticks (18 or over, consent), which the manage page never asks again.
 * Each field is checked by the L1 rule that owns it (`normaliseDistrict`,
 * `normaliseAvailability`, `normaliseSportChoice`); this file only puts
 * them together and names what is wrong, field by field, so the form can
 * say it next to the field.
 */
import { normaliseLang, type Lang } from "../i18n/lang";
import { LIVE_SPORTS, isLiveSport, normaliseSportChoice, sportChoiceKey, type LiveSports, type PoolSportChoice, type SportChoiceError } from "./sports";
import {
  POOL_SIGNUP,
  POOL_TRAVEL_MILES,
  normaliseAvailability,
  normaliseDistrict,
  type AvailabilityError,
  type PoolArea,
  type AvailabilityRange,
  type PoolTravelMiles,
} from "./rules";

/** What a profile stores (the `PoolProfile`, `PoolSport` and
 *  `PoolAvailability` rows' fields). */
export interface PoolFields {
  displayName: string;
  /** His postcode district ("SM1"): where he plays (`PoolArea`). */
  areaDistrict: string;
  maxMiles: PoolTravelMiles;
  availability: AvailabilityRange[];
  sports: PoolSportChoice[];
  language: Lang;
}

export type PoolFieldErrors = Partial<{
  name: "required";
  area: "required" | "district";
  maxMiles: "invalid";
  availability: AvailabilityError | "too-many";
  sports: SportChoiceError | "none" | "duplicate" | "too-many";
  adult: "required";
  consent: "required";
}>;

/**
 * `live`: which sports are offered (`LIVE_SPORTS`; tests pass others).
 * `keep`: the `sportChoiceKey`s already on his profile. A sport that is no
 * longer live stays saveable on the manage page, so editing his hours never
 * fails on a sport he picked when it was offered; a new one is refused.
 */
export interface PoolFieldsOptions {
  live?: LiveSports;
  keep?: readonly string[];
}

export type PoolFieldsResult = { ok: true; value: PoolFields } | { ok: false; errors: PoolFieldErrors };

const PHONE_LIKE = /\d[\d\s()+-]{6,}\d/;
/** A link with or without a scheme or slash: "evil.com", "bit.ly", "t.me",
 *  an email. The part after the dot is lower case, so an initial or a name
 *  written "St.John" is not one. */
const LINK_LIKE = /https?:|www\.|@|[A-Za-z0-9-]+\.[a-z]{2,}\b/;

/** The name as typed, tidied; null when empty, too long, or not a name. */
export function normaliseDisplayName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  if (!s || s.length > POOL_SIGNUP.nameMax) return null;
  if (PHONE_LIKE.test(s) || LINK_LIKE.test(s)) return null;
  return s;
}

/** Where he plays (`PoolArea`): a postcode district, required. Any other
 *  kind of area, chosen pitches included (retired 2026-10-25), is refused
 *  as no area; anything else sent with the district is ignored. */
function readArea(raw: unknown): { ok: true; area: PoolArea } | { ok: false; error: "required" | "district" } {
  const a = raw as { kind?: unknown; district?: unknown } | null;
  if (!a || typeof a !== "object" || a.kind !== "district") return { ok: false, error: "required" };
  const district = normaliseDistrict(a.district);
  return district ? { ok: true, area: { kind: "district", district } } : { ok: false, error: "district" };
}

function readSports(raw: unknown, opts: PoolFieldsOptions): { ok: true; value: PoolSportChoice[] } | { ok: false; error: NonNullable<PoolFieldErrors["sports"]> } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "none" };
  if (raw.length > POOL_SIGNUP.maxSports) return { ok: false, error: "too-many" };
  const out: PoolSportChoice[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = normaliseSportChoice((item ?? {}) as Parameters<typeof normaliseSportChoice>[0]);
    if (!r.ok) return { ok: false, error: r.error };
    const key = sportChoiceKey(r.value);
    if (!isLiveSport(r.value.sport, opts.live ?? LIVE_SPORTS) && !(opts.keep ?? []).includes(key)) return { ok: false, error: "bad-sport" };
    if (seen.has(key)) return { ok: false, error: "duplicate" };
    seen.add(key);
    out.push(r.value);
  }
  return { ok: true, value: out };
}

/** The fields both pages edit. Every wrong field is named at once. */
export function validatePoolFields(raw: unknown, opts: PoolFieldsOptions = {}): PoolFieldsResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: PoolFieldErrors = {};

  const displayName = normaliseDisplayName(r.name);
  if (!displayName) errors.name = "required";

  const area = readArea(r.area);
  if (!area.ok) errors.area = area.error;

  const maxMiles = (POOL_TRAVEL_MILES as readonly unknown[]).includes(r.maxMiles) ? (r.maxMiles as PoolTravelMiles) : null;
  if (maxMiles === null) errors.maxMiles = "invalid";

  let availability: AvailabilityRange[] = [];
  if (Array.isArray(r.availability) && r.availability.length > POOL_SIGNUP.maxRanges) errors.availability = "too-many";
  else {
    const a = normaliseAvailability(Array.isArray(r.availability) ? r.availability : []);
    if (a.ok) availability = a.value;
    else errors.availability = a.error;
  }

  const sports = readSports(r.sports, opts);
  if (!sports.ok) errors.sports = sports.error;

  if (Object.keys(errors).length > 0 || !displayName || !area.ok || maxMiles === null || !sports.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      displayName,
      areaDistrict: area.area.district,
      maxMiles,
      availability,
      sports: sports.value,
      language: normaliseLang(typeof r.language === "string" ? r.language : null),
    },
  };
}

/** Sign-up: the fields, and "I am 18 or over" and the consent, both ticked
 *  (a real `true`; unticked by default on the form). */
export function validatePoolSignup(raw: unknown, opts: PoolFieldsOptions = {}): PoolFieldsResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const fields = validatePoolFields(raw, opts);
  const ticks: PoolFieldErrors = {};
  if (r.adult !== true) ticks.adult = "required";
  if (r.consent !== true) ticks.consent = "required";
  if (Object.keys(ticks).length === 0) return fields;
  return { ok: false, errors: { ...(fields.ok ? {} : fields.errors), ...ticks } };
}

const CAMPAIGN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHARE_RE = /^[A-Za-z0-9]{4,12}$/;

/**
 * Where a visitor came from, off the /play URL: `?src=<campaign>` (a
 * PoolCampaign code: lowercase letters, digits, hyphens; slice G1's links,
 * `growth-rules.ts`; `?c=` is read the same) or `?ref=<share code>` (a
 * friend's PoolProfile.shareCode). Anything else is dropped, never stored.
 * Whether the code exists is the server's question.
 */
export function readSignupSource(params: Record<string, unknown>): { campaignCode: string | null; referralCode: string | null } {
  const raw = typeof params.src === "string" ? params.src : params.c;
  const c = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const ref = typeof params.ref === "string" ? params.ref.trim() : "";
  return {
    campaignCode: c && c.length <= 40 && CAMPAIGN_RE.test(c) ? c : null,
    referralCode: SHARE_RE.test(ref) ? ref : null,
  };
}
