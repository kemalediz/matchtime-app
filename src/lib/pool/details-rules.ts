/**
 * HIS TIMES AND FORMATS, ASKED LATER ON WHATSAPP (Kemal, 2026-11-04). PURE.
 *
 * The short /play form (`short-form.ts`) asks only the days. MatchTime asks
 * the rest in plain words: the welcome after his confirm message carries
 * the question ("what times suit you on Tuesday and Saturday, and which
 * formats do you play?"), and if he never answers, ONE later question,
 * `secondAskAfterDays` after he joined. Never a third: the defaults stand.
 * His answer is read by the pool's DM reader (`reply-reader.ts`, intent
 * "details"); these rules decide when a DM may be that answer and what it
 * changes. He can change them any time the same way, or on his manage page.
 *
 *   hoursPending    every day he has is still the short form's whole day.
 *   secondAskDue    the one later question is due.
 *   detailsInScope  a DM may be about his times and formats: always for
 *                   someone in no club (nothing else of MatchTime's talks
 *                   to him); for a club member only a swipe-reply to the
 *                   question, or a DM soon after it with no club DM since,
 *                   as the offer replies do (decision L6.1).
 *   applyDetails    his answer onto his profile's days and sports; null
 *                   when it changes nothing. Every value is checked here,
 *                   whatever the model said; the profile validator runs
 *                   again before anything is saved.
 *   detailsSummary  what is saved, for the one reply that says so.
 */
import { WEEK_ORDER } from "./form-state";
import type { AvailabilityRange } from "./rules";
import { parseMinutes } from "./rules";
import { DEFAULT_POOL_SPORT, SPORT_LEVELS, formatsOf, type PoolSportChoiceKey, type SportLevel } from "./sports";

export const POOL_DETAILS = Object.freeze({
  /** The one later question: this many days after he joined ... */
  secondAskAfterDays: 3,
  /** ... and never for a profile older than this (no question out of the blue). */
  secondAskWithinDays: 30,
  /** A club member's plain DM may answer the question this long after it. */
  answerWindowHours: 72,
  /** The later question goes at this London time on the day it is due. */
  secondAskAt: "18:00",
  /** At most this many later questions are queued per daily run. */
  perRun: 40,
});

/** The later question's platform DM purpose, and its one refId per profile
 *  (once ever; cancellable while it waits for its hour). */
export const DETAILS_ASK_PURPOSE = "pool-details-ask" as const;
export const detailsAskRefId = (profileId: string) => `pool-details-ask:${profileId}`;

const WHOLE_DAY = 24 * 60;

export function hoursPending(ranges: ReadonlyArray<Pick<AvailabilityRange, "fromMin" | "toMin"> & { day?: number }>): boolean {
  return ranges.length > 0 && ranges.every((r) => r.fromMin === 0 && r.toMin === WHOLE_DAY);
}

export function secondAskDue(p: {
  status: string;
  consentAt: Date | null;
  hoursPending: boolean;
  /** He answered already, whatever he said (`any time` keeps the whole days). */
  answered: boolean;
  /** The later question was queued already. */
  alreadyAsked: boolean;
  now: Date;
}): boolean {
  if (p.status !== "active" || !p.consentAt || p.answered || p.alreadyAsked || !p.hoursPending) return false;
  const age = p.now.getTime() - p.consentAt.getTime();
  return age >= POOL_DETAILS.secondAskAfterDays * 24 * 3600_000 && age <= POOL_DETAILS.secondAskWithinDays * 24 * 3600_000;
}

export function detailsInScope(a: {
  inAClub: boolean;
  profileStatus: string;
  /** MatchTime's question about his times and formats, newest; null when none. */
  ask: { sentAt: Date; quoted: boolean } | null;
  /** A DM from his club reached him after the question. */
  clubDmSinceAsk: boolean;
  now: Date;
}): boolean {
  if (a.profileStatus !== "active" && a.profileStatus !== "paused") return false;
  if (!a.inAClub) return true;
  if (!a.ask) return false;
  if (a.ask.quoted) return true;
  return !a.clubDmSinceAsk && a.now.getTime() - a.ask.sentAt.getTime() <= POOL_DETAILS.answerWindowHours * 3600_000;
}

/** What the reader says he told MatchTime (`reply-reader.ts`). */
export interface DetailsReading {
  /** Hours for the days he named; a day's list replaces that day's hours. */
  hours: Array<{ day: number; from: string; to: string }>;
  /** Days he says he can no longer play. */
  notDays: number[];
  /** Football's players a side he plays; empty when he did not say. */
  formats: number[];
  /** He plays any format. */
  anyFormat: boolean;
  level: SportLevel | null;
}

/** The two parts of a profile his answer may change, as the manage page holds them. */
export interface DetailsFields {
  availability: Array<{ day: number; from: string; to: string }>;
  sports: Array<{ sport: PoolSportChoiceKey; otherName: string; formats: number[]; level: SportLevel | null; levelText: string | null }>;
}

const isDay = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6;

function validRange(r: { day: unknown; from: unknown; to: unknown }): { day: number; from: string; to: string } | null {
  if (!isDay(r.day)) return null;
  const from = parseMinutes(r.from);
  const to = parseMinutes(r.to);
  if (from === null || to === null || to <= from) return null;
  return { day: r.day, from: r.from as string, to: r.to as string };
}

const byDayThenTime = (a: { day: number; from: string }, b: { day: number; from: string }) =>
  a.day - b.day || (parseMinutes(a.from) ?? 0) - (parseMinutes(b.from) ?? 0);

const sameAvailability = (a: DetailsFields["availability"], b: DetailsFields["availability"]) =>
  a.length === b.length && a.every((r, i) => r.day === b[i].day && parseMinutes(r.from) === parseMinutes(b[i].from) && parseMinutes(r.to) === parseMinutes(b[i].to));

export function applyDetails(current: DetailsFields, r: DetailsReading): DetailsFields | null {
  const before = [...current.availability].sort(byDayThenTime);
  const hours = r.hours.map(validRange).filter((x): x is NonNullable<typeof x> => x !== null);
  const named = new Set(hours.map((h) => h.day));
  let availability = [...before.filter((a) => !named.has(a.day)), ...hours];
  const dropped = availability.filter((a) => !r.notDays.includes(a.day));
  if (dropped.length > 0) availability = dropped;
  availability.sort(byDayThenTime);

  const legal = formatsOf(DEFAULT_POOL_SPORT);
  const formats = [...new Set(r.formats.filter((n) => legal.includes(n)))].sort((a, b) => a - b);
  const level = r.level && (SPORT_LEVELS as readonly string[]).includes(r.level) ? r.level : null;
  let sportsChanged = false;
  const sports = current.sports.map((s) => {
    if (s.sport !== DEFAULT_POOL_SPORT) return s;
    const next = { ...s };
    if (r.anyFormat) next.formats = [];
    else if (formats.length > 0) next.formats = formats;
    if (level) {
      next.level = level;
      next.levelText = null;
    }
    if (next.formats.join() !== s.formats.join() || next.level !== s.level || next.levelText !== s.levelText) sportsChanged = true;
    return next;
  });

  if (!sportsChanged && sameAvailability(availability, before)) return null;
  return { availability, sports };
}

export interface DetailsSummary {
  /** Monday first. `any`: the whole day. */
  days: Array<{ day: number; any: boolean; ranges: Array<{ from: string; to: string }> }>;
  /** Football's formats (empty: any); null when he has no football. */
  formats: number[] | null;
}

export function detailsSummary(f: DetailsFields): DetailsSummary {
  const days = WEEK_ORDER.filter((d) => f.availability.some((a) => a.day === d)).map((day) => {
    const ranges = f.availability.filter((a) => a.day === day).sort(byDayThenTime);
    const any = ranges.some((a) => parseMinutes(a.from) === 0 && parseMinutes(a.to) === WHOLE_DAY);
    return { day, any, ranges: any ? [] : ranges.map(({ from, to }) => ({ from, to })) };
  });
  const football = f.sports.find((s) => s.sport === DEFAULT_POOL_SPORT);
  return { days, formats: football ? [...football.formats] : null };
}
