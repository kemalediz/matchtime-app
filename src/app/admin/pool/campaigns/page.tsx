import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { formatLondon } from "@/lib/london-time";
import { listPoolCampaigns, poolWaysInWithoutCode, type PoolWayInNumbers } from "@/lib/pool/campaigns";
import { POOL_CAMPAIGN_CODE_MAX, POOL_CAMPAIGN_LABEL_MAX, POOL_CAMPAIGN_OWNER_SOURCES } from "@/lib/pool/growth-rules";
import { CampaignActiveToggle, CampaignCopyLink, NewCampaignForm } from "./campaign-controls";

/**
 * /admin/pool/campaigns: the platform owner's source codes for the player
 * pool (slice G1, plan 11.1). Each code ("linkedin-kemal",
 * "leaflet-sutton-oct") gives a `/play?src=CODE` link and a QR code (PNG
 * and SVG), and the page counts, per code, the visits to /play (since
 * 2026-11-03; link preview fetchers never count) next to the sign-ups it
 * brought: started, confirmed, still waiting for their WhatsApp message.
 * The same numbers for plain /play and for friends' links. Counts only,
 * no names.
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

/** One way in's numbers, left to right as the funnel runs. */
function WayInNumbers({ n, testid }: { n: PoolWayInNumbers; testid: string }) {
  const cells: Array<[string, number, string]> = [
    ["Visits", n.visits, "visits"],
    ["Sign-ups started", n.started, "started"],
    ["Confirmed on WhatsApp", n.confirmed, "confirmed"],
    ["Started, not confirmed yet", n.waiting, "waiting"],
  ];
  return (
    <dl className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
      {cells.map(([label, value, key]) => (
        <div key={key}>
          <dt className="text-slate-500">{label}</dt>
          <dd className="text-lg font-semibold text-slate-900" data-testid={`${testid}-${key}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function PoolCampaignsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();
  const [campaigns, withoutCode] = await Promise.all([listPoolCampaigns(), poolWaysInWithoutCode()]);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Player pool source codes</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          One code per place you share the pool: a LinkedIn post, a leaflet run, a poster. Each gets its own link and QR code, so each brings its own numbers.
          A friend&apos;s personal link counts as a referral, not here.
        </p>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          A visit is someone opening the link in a browser, once per visit. Link previews (Facebook, Nextdoor, WhatsApp, X) never count. Visits before November 2026 were not counted.
        </p>
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
