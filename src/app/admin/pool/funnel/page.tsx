import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { formatLondon } from "@/lib/london-time";
import { loadPoolFunnel } from "@/lib/pool/funnel-loader";
import {
  FUNNEL_STEPS,
  FUNNEL_STEP_LABEL,
  OFFER_HEALTH_ROWS,
  SOURCE_LABEL,
  funnelSearch,
  parseFunnelQuery,
  percent,
  sourceFilterLabel,
  sportFilterLabel,
  townLabel,
  type FunnelCounts,
} from "@/lib/pool/funnel-rules";
import { POOL_PROFILE_SOURCES } from "@/lib/pool/vocab";
import { FunnelChart } from "./funnel-chart";

/**
 * /admin/pool/funnel: the platform owner's player pool funnel (growth slice
 * G2, plan 11.4). Who signed up in a date range, by source and by week, and
 * how far they got: confirmed, active, offered, accepted, played, became
 * members. Plus the early sign-up list's size and offer health. Counts
 * only, never names or numbers. Every definition is in
 * `src/lib/pool/funnel-rules.ts`.
 *
 * OWNER ONLY: 404 to anybody who is not `User.isSuperadmin`, as
 * /admin/pool/campaigns. The CSV route checks again.
 */
export const dynamic = "force-dynamic";

const cell = "px-2 py-1.5 text-right tabular-nums";
const head = "px-2 py-1.5 text-right font-medium text-slate-500";

function StepCells({ counts }: { counts: FunnelCounts }) {
  return (
    <>
      {FUNNEL_STEPS.map((s) => (
        <td key={s} className={cell} data-step={s}>
          {counts[s]}
        </td>
      ))}
    </>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="min-w-0 space-y-3" data-testid={testId}>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {children}
    </section>
  );
}

function Scroll({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export default async function PoolFunnelPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();

  const now = new Date();
  const q = parseFunnelQuery(await searchParams, now);
  const { report, health } = await loadPoolFunnel(q, now);
  const day = (d: string) => formatLondon(new Date(`${d}T12:00:00Z`), "d MMM yyyy");

  return (
    <div className="min-w-0 space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Player pool funnel</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          People who signed up between the dates, followed to where they are now. Counts only, never names. Each step counts people who also reached the one
          before it.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm" aria-label="Filters">
        <div className="flex flex-col gap-1">
          <label htmlFor="funnel-from" className="text-slate-600">From</label>
          <input id="funnel-from" type="date" name="from" defaultValue={q.from} className="rounded-md border border-slate-300 px-2 py-1.5" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="funnel-to" className="text-slate-600">To</label>
          <input id="funnel-to" type="date" name="to" defaultValue={q.to} className="rounded-md border border-slate-300 px-2 py-1.5" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="funnel-town" className="text-slate-600">Town</label>
          <select id="funnel-town" name="town" defaultValue={q.town ?? ""} className="rounded-md border border-slate-300 px-2 py-1.5">
            <option value="">All towns</option>
            {report.options.towns.map((t) => (
              <option key={t} value={t}>
                {townLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="funnel-sport" className="text-slate-600">Sport</label>
          <select id="funnel-sport" name="sport" defaultValue={q.sport ?? ""} className="rounded-md border border-slate-300 px-2 py-1.5">
            <option value="">All sports</option>
            {report.options.sports.map((s) => (
              <option key={s} value={s}>
                {sportFilterLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="funnel-source" className="text-slate-600">Source</label>
          <select id="funnel-source" name="source" defaultValue={q.source ?? ""} className="max-w-[14rem] rounded-md border border-slate-300 px-2 py-1.5">
            <option value="">All sources</option>
            {report.options.sources.map((s) => (
              <option key={s} value={s}>
                {sourceFilterLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 font-semibold text-white">
          Show
        </button>
        <a href={`/admin/pool/funnel/funnel.csv?${funnelSearch(q)}`} download className="py-2 font-semibold text-blue-700 underline" data-testid="funnel-csv">
          Download CSV
        </a>
      </form>

      <p className="text-sm text-slate-600" data-testid="funnel-range">
        {day(q.from)} to {day(q.to)}
      </p>

      <dl className="flex flex-wrap gap-6 text-sm">
        <div>
          <dt className="text-slate-500">Early sign-up list (today)</dt>
          <dd className="text-2xl font-semibold text-slate-900" data-testid="funnel-early-list">
            {report.earlyList}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Signed up to became members</dt>
          <dd className="text-2xl font-semibold text-slate-900" data-testid="funnel-overall">
            {percent(report.overall) ?? "None"}
          </dd>
        </div>
      </dl>

      {report.empty ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-600" data-testid="funnel-empty">
          Nobody signed up between these dates with these filters.
        </p>
      ) : (
        <>
          <Section title="Funnel" testId="funnel-steps">
            <FunnelChart counts={report.total} conversion={report.conversion} />
            <Scroll label="Funnel steps">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-slate-500">Step</th>
                    <th className={head}>People</th>
                    <th className={head}>From the step before</th>
                  </tr>
                </thead>
                <tbody>
                  {FUNNEL_STEPS.map((s) => (
                    <tr key={s} className="border-t border-slate-100" data-testid="funnel-step" data-step={s}>
                      <td className="px-2 py-1.5 text-left">{FUNNEL_STEP_LABEL[s]}</td>
                      <td className={cell} data-testid="funnel-step-count">
                        {report.total[s]}
                      </td>
                      <td className={cell} data-testid="funnel-step-conversion">
                        {percent(report.conversion[s]) ?? "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </Section>

          <Section title="Sign-ups by week" testId="funnel-weeks">
            <Scroll label="Sign-ups by week">
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-slate-500">Week from</th>
                    <th className={head}>{FUNNEL_STEP_LABEL.signedUp}</th>
                    {POOL_PROFILE_SOURCES.map((s) => (
                      <th key={s} className={`${head} text-slate-400`}>
                        {SOURCE_LABEL[s]}
                      </th>
                    ))}
                    {FUNNEL_STEPS.slice(1).map((s) => (
                      <th key={s} className={head}>
                        {FUNNEL_STEP_LABEL[s]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.weeks.map((w) => (
                    <tr key={w.key} className="border-t border-slate-100" data-testid="funnel-week" data-week={w.key}>
                      <td className="px-2 py-1.5 text-left">{formatLondon(w.start, "d MMM yyyy")}</td>
                      <td className={cell}>{w.counts.signedUp}</td>
                      {POOL_PROFILE_SOURCES.map((s) => (
                        <td key={s} className={`${cell} text-slate-500`} data-source={s}>
                          {w.bySource[s]}
                        </td>
                      ))}
                      {FUNNEL_STEPS.slice(1).map((s) => (
                        <td key={s} className={cell} data-step={s}>
                          {w.counts[s]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </Section>

          <Section title="By source" testId="funnel-sources">
            <Scroll label="By source">
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium text-slate-500">Source</th>
                    {FUNNEL_STEPS.map((s) => (
                      <th key={s} className={head}>
                        {FUNNEL_STEP_LABEL[s]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.bySource.map((s) => (
                    <tr key={s.source} className="border-t border-slate-100" data-testid="funnel-source" data-source={s.source}>
                      <td className="px-2 py-1.5 text-left">{SOURCE_LABEL[s.source]}</td>
                      <StepCells counts={s.counts} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </Section>

          <Section title="By campaign code" testId="funnel-campaigns">
            {report.byCampaign.length === 0 ? (
              <p className="text-sm text-slate-600">No sign-ups through a campaign code in these dates.</p>
            ) : (
              <Scroll label="By campaign code">
                <table className="w-full whitespace-nowrap text-sm">
                  <thead>
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium text-slate-500">Code</th>
                      {FUNNEL_STEPS.map((s) => (
                        <th key={s} className={head}>
                          {FUNNEL_STEP_LABEL[s]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.byCampaign.map((c) => (
                      <tr key={c.code} className="border-t border-slate-100" data-testid="funnel-campaign" data-code={c.code}>
                        <td className="px-2 py-1.5 text-left">
                          <span className="font-mono">{c.code}</span>
                          {c.label && <span className="ml-2 text-slate-500">{c.label}</span>}
                        </td>
                        <StepCells counts={c.counts} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </Section>
        </>
      )}

      <Section title="Offer health" testId="funnel-health">
        <p className="max-w-2xl text-sm text-slate-600">Across the whole platform between the dates; the town, sport and source filters do not apply.</p>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          {OFFER_HEALTH_ROWS.map((o) => (
            <div key={o.label} className="rounded-xl border border-slate-200 bg-white p-3" data-testid="funnel-health-item">
              <dt className="text-slate-500">{o.label}</dt>
              <dd className="text-lg font-semibold text-slate-900">{o.value(health)}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}
