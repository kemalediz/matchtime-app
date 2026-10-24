/**
 * "PLAY ELSEWHERE": A CLUB MEMBER JOINS THE POOL FROM HIS OWN PROFILE
 * (slice L3, 2026-10-24). PURE and CLIENT-SAFE: no database, no clock.
 *
 * Plan 3.2: the same fields and the same consent wording as /play, but the
 * form starts from what his clubs already say about him, so most members
 * only tick the consent and check the days:
 *
 *   area       the geocoded venues his clubs play at (then their home
 *              venues), in that order, once each, at most
 *              POOL_SIGNUP.maxVenues; none geocoded: he types his
 *              postcode area as on /play
 *   days       each of his games' weekday and hours, widened to the half
 *              hours around it (the form's time steps); a game past
 *              midnight is two ranges on two days, as the L1 rule wants
 *   sports     each game's pool sport (`poolSportOfClubSport`, the one
 *              bridge), its known formats merged; a format the catalogue
 *              lacks means "any format"; nothing known: football, the
 *              form's own default
 *   name       first name and last initial, as /play asks
 *   language   his clubs' language when they all speak one, else English
 *
 * The result is the saved-profile shape `form-state.ts` `fromSavedProfile`
 * reads, so the card hands it to the one form model, the one fields
 * component and the one validator (`profile-fields.ts`). Nothing here
 * decides what is valid.
 *
 * `memberOptInPath`: a member whose account has a phone number joins on
 * the page and is active at once (that number is his WhatsApp sign-in, and
 * every DM MatchTime sends him already goes there); one with no number takes
 * the /play WhatsApp step, whose own message verifies one.
 */
import { normaliseLang, type Lang } from "../i18n/lang";
import { normaliseDisplayName } from "./profile-fields";
import { DEFAULT_POOL_TRAVEL_MILES, POOL_CONSENT_VERSION, POOL_SIGNUP, formatMinutes, normaliseAvailability, parseMinutes } from "./rules";
import { DEFAULT_POOL_SPORT, poolSportOfClubSport, type PoolSportChoiceKey, type PoolSportKey, type SportLevel } from "./sports";
import type { PoolProfileStatus } from "./vocab";

const DAY = 24 * 60;
const STEP = 30;

export interface MemberVenueFact {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

/** One live (non-guest) membership's club, as the prefill reads it. */
export interface MemberClubFacts {
  language: string;
  homeVenue: MemberVenueFact | null;
  /** The club's ACTIVE weekly games. */
  activities: Array<{
    dayOfWeek: number;
    time: string;
    matchDurationMins: number;
    sport: { preset: string | null; name: string; playersPerTeam: number };
    venue: MemberVenueFact | null;
  }>;
}

/** The saved-profile shape (`fromSavedProfile`'s input). */
export interface MemberPrefill {
  name: string;
  area: { kind: "district"; district: string } | { kind: "venues"; venueIds: string[] };
  venues: Array<{ id: string; name: string; address: string | null }>;
  maxMiles: number;
  availability: Array<{ day: number; from: string; to: string }>;
  sports: Array<{ sport: PoolSportChoiceKey; otherName: string; formats: number[]; level: SportLevel | null; levelText: string | null }>;
  language: Lang;
}

/** "Pete Peterson" -> "Pete P". "" when the validator would refuse it. */
export function shortDisplayName(raw: string | null | undefined): string {
  // The whole name first: a number or a link stored as a name is refused,
  // not shortened into something that looks like one.
  // (A very long name is judged on its first POOL_SIGNUP.nameMax letters.)
  const whole = normaliseDisplayName((raw ?? "").trim().replace(/\s+/g, " ").slice(0, POOL_SIGNUP.nameMax));
  if (!whole) return "";
  const parts = whole.split(" ");
  const short = parts.length === 1 ? parts[0] : `${parts[0]} ${Array.from(parts[parts.length - 1])[0]}`;
  return normaliseDisplayName(short) ?? "";
}

function prefillVenues(clubs: readonly MemberClubFacts[]): MemberPrefill["venues"] {
  const ordered = [...clubs.flatMap((c) => c.activities.map((a) => a.venue)), ...clubs.map((c) => c.homeVenue)];
  const out: MemberPrefill["venues"] = [];
  for (const v of ordered) {
    if (!v || v.lat === null || v.lng === null || out.some((x) => x.id === v.id)) continue;
    out.push({ id: v.id, name: v.name, address: v.address });
    if (out.length === POOL_SIGNUP.maxVenues) break;
  }
  return out;
}

/** One game's weekday and hours as ranges that never cross midnight. */
function gameRanges(a: MemberClubFacts["activities"][number]): Array<{ day: number; from: string; to: string }> {
  const start = parseMinutes(a.time);
  if (start === null || start >= DAY || !Number.isInteger(a.dayOfWeek) || a.dayOfWeek < 0 || a.dayOfWeek > 6) return [];
  const length = a.matchDurationMins > 0 ? a.matchDurationMins : 60;
  const from = Math.floor(start / STEP) * STEP;
  const to = Math.ceil((start + length) / STEP) * STEP;
  if (to <= DAY) return [{ day: a.dayOfWeek, from: formatMinutes(from), to: formatMinutes(to) }];
  return [
    { day: a.dayOfWeek, from: formatMinutes(from), to: formatMinutes(DAY) },
    { day: (a.dayOfWeek + 1) % 7, from: formatMinutes(0), to: formatMinutes(Math.min(to - DAY, DAY)) },
  ];
}

function prefillAvailability(clubs: readonly MemberClubFacts[]): MemberPrefill["availability"] {
  const ranges = clubs.flatMap((c) => c.activities.flatMap(gameRanges));
  if (ranges.length === 0) return [];
  const merged = normaliseAvailability(ranges);
  if (!merged.ok) return [];
  return merged.value.map((r) => ({ day: r.day, from: formatMinutes(r.fromMin), to: formatMinutes(r.toMin) }));
}

function prefillSports(clubs: readonly MemberClubFacts[]): MemberPrefill["sports"] {
  const bySport = new Map<PoolSportKey, Set<number>>();
  for (const a of clubs.flatMap((c) => c.activities)) {
    const s = poolSportOfClubSport(a.sport);
    if (!s) continue;
    const formats = bySport.get(s.sport) ?? new Set<number>();
    if (s.format !== null) formats.add(s.format);
    bySport.set(s.sport, formats);
  }
  if (bySport.size === 0) bySport.set(DEFAULT_POOL_SPORT, new Set());
  return [...bySport].map(([sport, formats]) => ({
    sport,
    otherName: "",
    formats: [...formats].sort((x, y) => x - y),
    level: null,
    levelText: null,
  }));
}

function prefillLanguage(clubs: readonly MemberClubFacts[]): Lang {
  const langs = new Set(clubs.map((c) => normaliseLang(c.language)));
  return langs.size === 1 ? [...langs][0] : "en";
}

export function memberPrefill(input: { name: string | null; clubs: readonly MemberClubFacts[] }): MemberPrefill {
  const venues = prefillVenues(input.clubs);
  return {
    name: shortDisplayName(input.name),
    area: venues.length > 0 ? { kind: "venues", venueIds: venues.map((v) => v.id) } : { kind: "district", district: "" },
    venues,
    maxMiles: DEFAULT_POOL_TRAVEL_MILES,
    availability: prefillAvailability(input.clubs),
    sports: prefillSports(input.clubs),
    language: prefillLanguage(input.clubs),
  };
}

export type MemberOptInPath =
  /** He has a profile (active, paused or stopped): manage it there. */
  | { kind: "in-pool"; status: Exclude<PoolProfileStatus, "pending-verify"> }
  /** His account has a number: join here, active at once. */
  | { kind: "join-here" }
  /** No number: the /play WhatsApp step verifies one. */
  | { kind: "join-whatsapp" }
  /** He started the WhatsApp step and has not sent the message yet. */
  | { kind: "waiting-whatsapp" };

export function memberOptInPath(args: { hasPhone: boolean; profile: { status: PoolProfileStatus } | null }): MemberOptInPath {
  const { profile } = args;
  if (profile && profile.status !== "pending-verify") return { kind: "in-pool", status: profile.status };
  // A number on his account now (added since he started): join here; the
  // waiting sign-up is dropped by the join.
  if (args.hasPhone) return { kind: "join-here" };
  return profile ? { kind: "waiting-whatsapp" } : { kind: "join-whatsapp" };
}

/**
 * The consent a member gives by ticking the box on his own profile page
 * (and "I am 18 or over"): channel "web", and what proves it is the
 * signed-in request (`web:<userId>:<ms>:profile`), as "start again" on the
 * manage page records it. Exactly the CHECK's consent fields.
 */
export function memberJoinConsent(userId: string, now: Date) {
  return {
    consentAt: now,
    consentVersion: POOL_CONSENT_VERSION,
    consentChannel: "web" as const,
    consentEvidence: `web:${userId}:${now.getTime()}:profile`,
    adultConfirmedAt: now,
  };
}
