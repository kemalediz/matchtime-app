"use client";

/**
 * Slice 6 controls on /admin/months (plan section 7): the collector's
 * "Record refund" for somebody who is owed money, and the organiser's
 * "Change the share" for a month somebody has already paid for. Both
 * submit to a server action that decides everything again (who may, the
 * amounts) and refuses with a reason. Neither moves money: MatchTime never
 * sees it.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { changeMonthShare, recordMonthRefund } from "@/app/actions/month-close";
import { t } from "@/lib/i18n/t";
import { poundsText } from "@/lib/squad-month-rules";

const control = "h-8 w-24 px-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-40";
const button = "h-8 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40";

/** The total given back to one person for a month. The collector's word. */
export function RefundForm(props: { orgId: string; monthId: string; userId: string; lang: string | null | undefined; suggestedPence: number | null }) {
  const s = t(props.lang);
  const router = useRouter();
  const [amount, setAmount] = useState(poundsText(props.suggestedPence));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await recordMonthRefund(props.orgId, props.monthId, props.userId, amount);
      if (!res.ok) toast.error(res.error === "not-collector" ? s.mth_refund_collector_only : s.mth_refund_error);
      router.refresh();
    } catch {
      toast.error(s.mth_refund_error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="refund-form">
      <input className={control} inputMode="decimal" aria-label={s.mth_refund_label} placeholder={s.mth_refund_label} value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="refund-amount" />
      <button type="button" className={button} disabled={saving || amount.trim() === ""} onClick={save} data-testid="refund-save">
        {s.mth_refund_btn}
      </button>
    </span>
  );
}

/** A new share after payments. Needs the box ticked: no payment changes. */
export function ShareChangeForm(props: { orgId: string; monthId: string; lang: string | null | undefined; sharePence: number | null; concessionPence: number | null }) {
  const s = t(props.lang);
  const router = useRouter();
  const [share, setShare] = useState(poundsText(props.sharePence));
  const [concession, setConcession] = useState(poundsText(props.concessionPence));
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await changeMonthShare(props.orgId, props.monthId, { share, concession, acknowledged });
      if (!res.ok) setError(s.mth_price_error({ key: res.error }));
      else {
        setAcknowledged(false);
        router.refresh();
      }
    } catch {
      setError(s.mth_price_error({ key: "" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3" data-testid="share-change-form">
      <h4 className="text-sm font-semibold text-slate-800">{s.mth_share_change_title}</h4>
      <p className="text-xs text-slate-600 max-w-2xl">{s.mth_share_change_lead}</p>
      <div className="flex flex-wrap gap-4">
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mth_price_share}</span>
          <input className={`${control} w-32`} inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} data-testid="share-change-share" />
        </label>
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mth_price_concession}</span>
          <input className={`${control} w-32`} inputMode="decimal" value={concession} onChange={(e) => setConcession(e.target.value)} data-testid="share-change-concession" />
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} data-testid="share-change-ack" />
        {s.mth_share_change_ack}
      </label>
      {error && (
        <p className="text-sm text-red-600" role="alert" data-testid="share-change-error">
          {error}
        </p>
      )}
      <button type="button" className="h-9 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white disabled:opacity-40" disabled={saving || !acknowledged} onClick={save} data-testid="share-change-save">
        {s.mth_share_change_btn}
      </button>
    </div>
  );
}
