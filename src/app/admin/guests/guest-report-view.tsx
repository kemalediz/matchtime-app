/**
 * The Report tab (pool slice L5b): by month or season, filtered by sport and
 * venue, with a CSV download. A plain GET form, so it works without
 * JavaScript and every view has a URL. The maths is `buildGuestReport`.
 */
import { Download } from "lucide-react";
import type { Strings } from "@/lib/i18n/t";
import { fillRatePercent, REPORT_PERIODS, type GuestPageQuery, type GuestReport, type ReportRow } from "@/lib/pool/guest-report";
import { EmptyState } from "./guest-tabs";
import { reportHeader, reportPeriodLabel } from "./report-labels";

const control =
  "h-10 w-full sm:w-auto px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500";

export function csvHref(q: GuestPageQuery): string {
  const p = new URLSearchParams({ period: q.period });
  if (q.sportId) p.set("sport", q.sportId);
  if (q.venue) p.set("venue", q.venue);
  return `/admin/guests/report.csv?${p.toString()}`;
}

export function GuestReportView(props: {
  s: Strings;
  lang: string;
  query: GuestPageQuery;
  report: GuestReport;
  options: { sports: { id: string; name: string }[]; venues: string[] };
}) {
  const { s, lang, query, report, options } = props;
  const header = reportHeader(lang);
  const cells = (r: ReportRow) => [r.asked, r.accepted, r.played, r.noShows, r.becameMembers, r.shortGames, r.rescued, fillRatePercent(r.fillRate) ?? s.gst_fill_none];
  return (
    <div className="space-y-4">
      <form method="get" action="/admin/guests" className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 bg-white rounded-xl border border-slate-200 shadow-sm p-4" data-testid="guest-report-filters">
        <input type="hidden" name="tab" value="report" />
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          {s.gst_period}
          <select name="period" defaultValue={query.period} className={control} data-testid="guest-report-period">
            {REPORT_PERIODS.map((p) => (
              <option key={p} value={p}>
                {p === "month" ? s.gst_period_month : s.gst_period_season}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          {s.gst_filter_sport}
          <select name="sport" defaultValue={query.sportId ?? ""} className={control} data-testid="guest-report-sport">
            <option value="">{s.gst_filter_all}</option>
            {options.sports.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          {s.gst_filter_venue}
          <select name="venue" defaultValue={query.venue ?? ""} className={control} data-testid="guest-report-venue">
            <option value="">{s.gst_filter_all}</option>
            {options.venues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" data-testid="guest-report-apply" className="h-10 px-4 rounded-lg bg-slate-800 text-sm font-medium text-white hover:bg-slate-700">
          {s.gst_filter_apply}
        </button>
        <a
          href={csvHref(query)}
          download
          data-testid="guest-report-csv"
          className="h-10 px-4 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 sm:ml-auto"
        >
          <Download className="w-4 h-4" aria-hidden />
          {s.gst_csv}
        </a>
      </form>

      {report.rows.length === 0 ? (
        <EmptyState testId="guest-empty-report">{s.gst_empty_report}</EmptyState>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="guest-report-table">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  {header.map((h, i) => (
                    <th key={h} scope="col" className={`px-3 py-2 font-semibold whitespace-nowrap ${i === 0 ? "sticky left-0 bg-white" : "text-right"}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.key} data-testid="guest-report-row" data-period={r.key} className="border-b border-slate-50">
                    <th scope="row" className="sticky left-0 bg-white px-3 py-2 text-left font-medium text-slate-800 whitespace-nowrap">
                      {reportPeriodLabel(lang, query.period, r.key)}
                    </th>
                    {cells(r).map((c, i) => (
                      <td key={i} className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid="guest-report-total" className="font-semibold text-slate-800">
                  <th scope="row" className="sticky left-0 bg-white px-3 py-2 text-left">
                    {s.gst_total}
                  </th>
                  {cells(report.total).map((c, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums">
                      {c}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="px-4 py-3 border-t border-slate-100 text-xs text-slate-500" data-testid="guest-report-help">
            {s.gst_report_help}
          </p>
        </div>
      )}
    </div>
  );
}
