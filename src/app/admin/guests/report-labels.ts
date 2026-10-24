/**
 * The Report's words, shared by the table and the CSV download, so both
 * say the same thing in the club's language (pool slice L5b).
 */
import { monthYearLabel } from "@/lib/i18n/dates";
import { t } from "@/lib/i18n/t";
import { londonDateTimeToUtc } from "@/lib/london-time";
import type { ReportPeriod } from "@/lib/pool/guest-report";

export function reportHeader(lang: string): string[] {
  const s = t(lang);
  return [
    s.gst_period,
    s.gst_col_asked,
    s.gst_col_accepted,
    s.gst_col_played,
    s.gst_col_no_shows,
    s.gst_col_members,
    s.gst_col_short,
    s.gst_col_rescued,
    s.gst_col_fill_rate,
  ];
}

/** "October 2026" / "Ekim 2026", or "Season 2026/27" / "2026/27 sezonu". */
export function reportPeriodLabel(lang: string, period: ReportPeriod, key: string): string {
  if (period === "season") return t(lang).gst_season({ key });
  return monthYearLabel(lang, londonDateTimeToUtc(`${key}-01`, "12:00"));
}
