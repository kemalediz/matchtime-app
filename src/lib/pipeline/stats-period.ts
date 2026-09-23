/**
 * THE PERIOD OF A STATS QUESTION, FROM WORDS TO A DATE (2026-09-23).
 *
 * "@Match Time who has played most matches in the last 1 year?" was
 * answered "Most appearances in the last 30 days": the period was
 * discarded because nothing could hold it. The question extractor now
 * names it (`period`, `periodCount`, `periodUnit`), and this module is
 * the only place it becomes a date. The model never does arithmetic on
 * the calendar.
 *
 * Calendar periods ("this month") start at London midnight, the zone
 * every club this product serves plays in (`london-time.ts`). Rolling
 * periods ("the last 3 months") count back from the instant.
 *
 * PURE. No clock (`now` is passed in), no Prisma: `stats-answer.ts` and
 * `compose.ts` import this.
 */
import { subDays, subMonths, subWeeks, subYears } from "date-fns";
import { formatLondon, londonDateTimeToUtc } from "../london-time";
import type { StatsPeriod, StatsPeriodUnit } from "./types";

/** The largest count a rolling period keeps. "The last 5000 days" is
 *  the whole record either way; a cap keeps the date arithmetic sane. */
export const PERIOD_MAX_COUNT = 100;

const UNITS: readonly StatsPeriodUnit[] = ["day", "week", "month", "year"];
const CALENDAR_UNITS = ["week", "month", "year"] as const;

/**
 * PURE. The extractor's three fields, as a `StatsPeriod`. A period that
 * cannot be read is `null` with a `problem` the caller logs as a
 * degradation: dropped loudly, never guessed, and the question is still
 * answered (for the whole record, which the answer then says).
 */
export function parsePeriodFields(raw: { period?: unknown; periodCount?: unknown; periodUnit?: unknown }): {
  period: StatsPeriod | null;
  problem: string | null;
} {
  const kind = typeof raw.period === "string" ? raw.period.toLowerCase() : "";
  const unit = typeof raw.periodUnit === "string" ? raw.periodUnit.toLowerCase() : "";
  if (!kind || kind === "none") return { period: null, problem: null };
  if (kind === "season") return { period: { kind: "season" }, problem: null };
  if (kind === "all_time") return { period: { kind: "all_time" }, problem: null };
  if (kind === "last") {
    if (!UNITS.includes(unit as StatsPeriodUnit)) {
      return { period: null, problem: `a "last" period with no usable unit ("${String(raw.periodUnit)}"); answered for the whole record` };
    }
    const n = typeof raw.periodCount === "number" && Number.isFinite(raw.periodCount) && raw.periodCount >= 1 ? Math.floor(raw.periodCount) : 1;
    return { period: { kind: "last", count: Math.min(n, PERIOD_MAX_COUNT), unit: unit as StatsPeriodUnit }, problem: null };
  }
  if (kind === "this") {
    if (!(CALENDAR_UNITS as readonly string[]).includes(unit)) {
      return { period: null, problem: `a "this" period with no calendar unit ("${String(raw.periodUnit)}"); answered for the whole record` };
    }
    return { period: { kind: "this", unit: unit as (typeof CALENDAR_UNITS)[number] }, problem: null };
  }
  return { period: null, problem: `unknown stats period "${String(raw.period)}"; answered for the whole record` };
}

/** PURE. Does this period cut the club's record, or is it the whole of
 *  it? The season, all time and no period at all are the whole record. */
export function cutsTheRecord(
  p: StatsPeriod | null | undefined,
): p is Extract<StatsPeriod, { kind: "last" | "this" }> {
  return !!p && (p.kind === "last" || p.kind === "this");
}

/** PURE. The key a cut period's tables are loaded and looked up under. */
export function periodKey(p: StatsPeriod): string {
  switch (p.kind) {
    case "last":
      return `last:${p.count}:${p.unit}`;
    case "this":
      return `this:${p.unit}`;
    default:
      return p.kind;
  }
}

/** A London calendar date ("yyyy-MM-dd") at London midnight, as an instant. */
function londonMidnight(ymd: string): Date {
  return londonDateTimeToUtc(ymd, "00:00");
}

/**
 * PURE. Where a period starts, or `null` for the whole record.
 */
export function periodSince(p: StatsPeriod, now: Date): Date | null {
  switch (p.kind) {
    case "last":
      switch (p.unit) {
        case "day":
          return subDays(now, p.count);
        case "week":
          return subWeeks(now, p.count);
        case "month":
          return subMonths(now, p.count);
        case "year":
          return subYears(now, p.count);
      }
      return null;
    case "this": {
      if (p.unit === "year") return londonMidnight(`${formatLondon(now, "yyyy")}-01-01`);
      if (p.unit === "month") return londonMidnight(`${formatLondon(now, "yyyy-MM")}-01`);
      // The week starts on Monday. Step back over whole London days from
      // today's date, then take that date's midnight: DST-safe because
      // the arithmetic is on a calendar date, not on an instant.
      const isoDay = Number(formatLondon(now, "i")); // 1 = Monday
      const today = formatLondon(now, "yyyy-MM-dd");
      const noonUtc = new Date(`${today}T12:00:00.000Z`);
      const monday = subDays(noonUtc, isoDay - 1).toISOString().slice(0, 10);
      return londonMidnight(monday);
    }
    default:
      return null;
  }
}
