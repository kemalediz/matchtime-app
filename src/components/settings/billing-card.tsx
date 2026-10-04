import Link from "next/link";
import { CreditCard } from "lucide-react";
import { WaText } from "@/components/billing/wa-text";

/** The card's data, as /api/org/settings returns it (`billing`). */
export interface BillingCardData {
  title: string;
  lines: string[];
  who: string;
  cardOnFile: string;
  tip: string | null;
  openLabel: string;
  chooseCollectorLabel: string | null;
  billingPath: string;
  /** Slice P4: this month so far, and the last closed month. */
  month?: string | null;
  lastMonth?: string | null;
}

/**
 * The /admin/settings billing card (club fee billing, slice B2, plan 8.1).
 * Rendered only when the API sends one: never with BILLING_ENABLED off,
 * never for an exempt club. The same for every OWNER and ADMIN; the card
 * itself is changed only on the billing page, by the person who pays.
 */
export function BillingSettingsCard({ data, collectorAnchor }: { data: BillingCardData; collectorAnchor: string | null }) {
  return (
    <section id="billing" data-testid="settings-billing-card" className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-6">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-slate-500" />
        <h2 className="font-semibold text-slate-800">{data.title}</h2>
      </div>
      <div className="p-6 space-y-3 text-sm text-slate-700">
        {data.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        {data.month && (
          <p data-testid="settings-billing-month" className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-900">
            {data.month}
          </p>
        )}
        {data.lastMonth && <p data-testid="settings-billing-last-month">{data.lastMonth}</p>}
        <p className="text-slate-500">{data.who}</p>
        <p className="text-slate-500">{data.cardOnFile}</p>
        {data.tip && (
          <p className="rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-emerald-900">
            <WaText text={data.tip} />
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Link
            href={data.billingPath}
            className="inline-flex items-center gap-2 px-4 h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            {data.openLabel}
          </Link>
          {data.chooseCollectorLabel && collectorAnchor && (
            <a href={collectorAnchor} className="text-sm font-medium text-blue-700 hover:underline">
              {data.chooseCollectorLabel}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
