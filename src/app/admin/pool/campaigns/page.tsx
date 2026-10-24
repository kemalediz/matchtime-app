import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { formatLondon } from "@/lib/london-time";
import { listPoolCampaigns } from "@/lib/pool/campaigns";
import { POOL_CAMPAIGN_CODE_MAX, POOL_CAMPAIGN_LABEL_MAX, POOL_CAMPAIGN_OWNER_SOURCES } from "@/lib/pool/growth-rules";
import { CampaignActiveToggle, CampaignCopyLink, NewCampaignForm } from "./campaign-controls";

/**
 * /admin/pool/campaigns: the platform owner's source codes for the player
 * pool (slice G1, plan 11.1). Each code ("linkedin-kemal",
 * "leaflet-sutton-oct") gives a `/play?src=CODE` link and a QR code (PNG
 * and SVG), and the page counts the sign-ups each brought: still waiting
 * for their WhatsApp message, and confirmed. Counts only, no names.
 *
 * OWNER ONLY: 404 to anybody who is not `User.isSuperadmin`, as
 * /admin/health. The actions check again (`app/actions/pool-campaigns.ts`)
 * and so does the QR download (`[code]/qr/route.ts`).
 */
export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = { linkedin: "LinkedIn", leaflet: "Leaflet", club: "Club share post", other: "Other" };

export default async function PoolCampaignsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();
  const campaigns = await listPoolCampaigns();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Player pool source codes</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          One code per place you share the pool: a LinkedIn post, a leaflet run, a poster. Each gets its own link and QR code, so each brings its own numbers.
          A friend&apos;s personal link counts as a referral, not here.
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
              <dl className="mt-3 flex flex-wrap gap-6 text-sm">
                <div>
                  <dt className="text-slate-500">Confirmed on WhatsApp</dt>
                  <dd className="text-lg font-semibold text-slate-900" data-testid="campaign-confirmed">
                    {c.confirmed}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Started, not confirmed yet</dt>
                  <dd className="text-lg font-semibold text-slate-900" data-testid="campaign-waiting">
                    {c.waiting}
                  </dd>
                </div>
              </dl>
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
    </div>
  );
}
