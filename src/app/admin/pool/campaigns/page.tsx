import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { formatLondon } from "@/lib/london-time";
import { listPoolCampaigns, poolWaysInWithoutCode, type PoolWayInNumbers } from "@/lib/pool/campaigns";
import { POOL_CAMPAIGN_CODE_MAX, POOL_CAMPAIGN_LABEL_MAX, POOL_CAMPAIGN_OWNER_SOURCES } from "@/lib/pool/growth-rules";
import {
  POOL_FUNNEL_PERIODS,
  poolFunnelDrops,
  poolFunnelPeriodStart,
  readPoolFunnelPeriod,
  type PoolFunnelDrop,
  type PoolFunnelPeriod,
  type PoolFunnelStep,
} from "@/lib/pool/visit-rules";
import { CampaignActiveToggle, CampaignCopyLink, NewCampaignForm } from "./campaign-controls";

/**
 * /admin/pool/campaigns: the platform owner's source codes for the player
 * pool (slice G1, plan 11.1). Each code ("linkedin-kemal",
 * "leaflet-sutton-oct") gives a `/play?src=CODE` link and a QR code (PNG
 * and SVG), and the page counts, per code, the four steps of the sign-up
 * in the chosen period (today, 7 days, 30 days; `?period=`): opened the
 * page, started the form, sent it, confirmed on WhatsApp, with how many
 * stopped between each (2026-11-04, `src/lib/pool/visit-rules.ts`). Under
 * them, all time, the sign-ups it brought. The same for plain /play and for
 * friends' links. Counts only, no names. English only, as the rest of the
 * owner's pages.
 *
 * OWNER ONLY: 404 to anybody who is not `User.isSuperadmin`, as
 * /admin/health. The actions check again (`app/actions/pool-campaigns.ts`)
 * and so does the QR download (`[code]/qr/route.ts`).
 */
export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  leaflet: "Leaflet",
  facebook: "Facebook",
  nextdoor: "Nextdoor",
  club: "Club share post",
  other: "Other",
};

const PERIOD_LABEL: Record<PoolFunnelPeriod, string> = { today: "Today", "7d": "7 days", "30d": "30 days" };

const STEP_LABEL: Record<PoolFunnelStep, string> = {
  opened: "Opened the page",
  started: "Started the form",
  sent: "Sent the form",
  confirmed: "Confirmed on WhatsApp",
};

/** Who did not get to this step, in words. */
const LOST_WORDS: Record<Exclude<PoolFunnelStep, "opened">, string> = {
  started: "did not start",
  sent: "did not send it",
  confirmed: "did not confirm",
};

function lostLine(d: PoolFunnelDrop): string | null {
  if (d.lost === null || d.step === "opened") return null;
  if (d.lost === 0) return "nobody stopped";
  return `${d.lost} ${LOST_WORDS[d.step]} (${d.lostPct}%)`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One way in's funnel, left to right as a person goes, then its sign-ups all time. */
function WayInNumbers({ n, testid }: { n: PoolWayInNumbers; testid: string }) {
  return (
    <>
      <ol className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {poolFunnelDrops(n.funnel).map((d) => {
          const lost = lostLine(d);
          return (
            <li key={d.step} className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-slate-500">{STEP_LABEL[d.step]}</p>
              <p className="text-lg font-semibold text-slate-900" data-testid={`${testid}-${d.step}`}>
                {d.count}
              </p>
              {lost && (
                <p className="text-xs text-slate-600" data-testid={`${testid}-lost-${d.step}`}>
                  {lost}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-slate-500" data-testid={`${testid}-alltime`}>
        All time: {plural(n.allTime.signups, "sign-up", "sign-ups")}, {n.allTime.confirmed} confirmed, {n.allTime.waiting} still waiting.
      </p>
    </>
  );
}

function PeriodPicker({ period }: { period: PoolFunnelPeriod }) {
  return (
    <nav aria-label="Period" className="flex flex-wrap gap-2 text-sm">
      {POOL_FUNNEL_PERIODS.map((p) => (
        <a
          key={p}
          href={`?period=${p}`}
          aria-current={p === period ? "page" : undefined}
          className={
            p === period
              ? "rounded-full bg-slate-900 px-3 py-1 font-semibold text-white"
              : "rounded-full border border-slate-300 px-3 py-1 text-slate-700 hover:bg-slate-100"
          }
        >
          {PERIOD_LABEL[p]}
        </a>
      ))}
    </nav>
  );
}

export default async function PoolCampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();
  const period = readPoolFunnelPeriod((await searchParams).period);
  const fromDay = poolFunnelPeriodStart(period, new Date());
  const [campaigns, withoutCode] = await Promise.all([listPoolCampaigns(fromDay), poolWaysInWithoutCode(fromDay)]);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Player pool source codes</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          One code per place you share the pool: a LinkedIn post, a leaflet run, a poster. Each gets its own link and QR code, so each brings its own numbers.
          A friend&apos;s personal link counts as a referral, not here.
        </p>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Each sign-up has four steps: opened the page in a browser, started the form (the first tap in it), sent the form, and confirmed by sending the WhatsApp
          message. Opened and started count once per visit, and link previews (Facebook, Nextdoor, WhatsApp, X) never count. Each step counts on the day it
          happened, so someone who opened yesterday and sent today counts on both days. Opened was first counted on 3 November 2026, the other steps on 4
          November 2026.
        </p>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-900">Steps counted over</p>
        <PeriodPicker period={period} />
      </div>

      <NewCampaignForm
        sources={POOL_CAMPAIGN_OWNER_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
        codeMax={POOL_CAMPAIGN_CODE_MAX}
        labelMax={POOL_CAMPAIGN_LABEL_MAX}
      />

      {campaigns.length === 0 ? (
        <p className="text-sm text-slate-600" data-testid="no-campaigns">
          No codes yet.
        </p>
      ) : (
        <ul className="space-y-4" aria-label="Source codes">
          {campaigns.map((c) => (
            <li key={c.code} data-testid="campaign-row" data-code={c.code} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-base font-semibold text-slate-900">{c.code}</p>
                  <p className="text-sm text-slate-700">
                    {c.label} <span className="text-slate-500">({SOURCE_LABEL[c.source] ?? c.source}, made {formatLondon(c.createdAt, "d MMM yyyy")})</span>
                  </p>
                </div>
                <CampaignActiveToggle code={c.code} active={c.active} />
              </div>
              <p className="mt-2 break-all font-mono text-sm text-slate-800" data-testid="campaign-url">
                {c.url}
              </p>
              <WayInNumbers n={c} testid="campaign" />
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <CampaignCopyLink url={c.url} />
                <a href={`/admin/pool/campaigns/${encodeURIComponent(c.code)}/qr?format=png`} download className="font-semibold text-blue-700 underline">
                  QR code (PNG)
                </a>
                <a href={`/admin/pool/campaigns/${encodeURIComponent(c.code)}/qr?format=svg`} download className="font-semibold text-blue-700 underline">
                  QR code (SVG)
                </a>
              </div>
              {!c.active && <p className="mt-2 text-xs text-slate-500">Switched off: new sign-ups through this link count as the web.</p>}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="without-code" className="space-y-4">
        <h3 id="without-code" className="text-base font-semibold text-slate-900">
          Without a code
        </h3>
        <div data-testid="way-in-direct" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="font-semibold text-slate-900">Plain /play link</p>
          <p className="text-sm text-slate-600">No code, or a code that does not exist or is switched off. Its sign-ups count as the web.</p>
          <WayInNumbers n={withoutCode.direct} testid="direct" />
        </div>
        <div data-testid="way-in-referral" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="font-semibold text-slate-900">Friends&apos; links</p>
          <p className="text-sm text-slate-600">A player&apos;s own link from Bring a friend.</p>
          <WayInNumbers n={withoutCode.referral} testid="referral" />
        </div>
      </section>
    </div>
  );
}
