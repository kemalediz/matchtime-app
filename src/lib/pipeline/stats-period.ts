/**
 * WHERE A STATS PERIOD STARTS (2026-09-23).
 *
 * The unified answer is shown its shorter spans of the tables (the last 30
 * days, this year) beside the whole record, and this module is the only
 * place a period becomes a date. The model never does arithmetic on the
 * calendar. (The extractor's period fields, and the parsing and keys that
 * served the stats answers, were deleted with them on 2026-11-18.)
 *
 * Calendar periods ("this month") start at London midnight, the zone
 * every club this product serves plays in (`london-time.ts`). Rolling
 * periods ("the last 3 months") count back from the instant.
 *
 * PURE. No clock (`now` is passed in), no Prisma.
 */
import { subDays, subMonths, subWeeks, subYears } from "date-fns";
import { formatLondon, londonDateTimeToUtc } from "../london-time";
import type { StatsPeriod } from "./types";

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
