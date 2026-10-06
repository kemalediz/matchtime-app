"use client";

/**
 * The price form on /admin/months (slice 4, plan 4.2): the share per game
 * the organiser types (D1), an optional concession share and venue cost,
 * and the pay-by date. The suggestion (venue cost over the regulars,
 * rounded up to 50p) is only that. Submits to `setMonthPrice`, which
 * validates everything again on the server and refuses with a reason this
 * form puts into words. Also the collector's "Confirm paid" button.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setMonthPaid, setMonthPrice } from "@/app/actions/month-payment";
import { SectionInfo } from "@/components/info/section-info";
import { t } from "@/lib/i18n/t";
import { pounds } from "@/lib/month-payment-copy";
import { suggestSharePence } from "@/lib/month-payment-rules";
import { parsePounds, poundsText } from "@/lib/squad-month-rules";

const control = "h-9 w-32 px-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-40 disabled:bg-slate-50";

export function PriceForm(props: {
  orgId: string;
  monthId: string;
  lang: string | null | undefined;
  sharePence: number | null;
  concessionPence: number | null;
  venuePence: number | null;
  /** London "YYYY-MM-DDTHH:mm". */
  payBy: string;
  regulars: number;
  priced: boolean;
  locked: boolean;
  /** The club fee in month terms, already in words, or null. */
  feeTip: string | null;
}) {
  const s = t(props.lang);
  const router = useRouter();
  const [share, setShare] = useState(poundsText(props.sharePence));
  const [concession, setConcession] = useState(poundsText(props.concessionPence));
  const [venue, setVenue] = useState(poundsText(props.venuePence));
  const [payBy, setPayBy] = useState(props.payBy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestion = suggestSharePence(parsePounds(venue), props.regulars);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await setMonthPrice(props.orgId, props.monthId, { share, concession, venue, payBy });
      if (!res.ok) setError(s.mth_price_error({ key: res.error }));
      else router.refresh();
    } catch {
      setError(s.mth_price_error({ key: "" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3" data-testid="price-form">
      <h4 className="flex items-center gap-1 text-sm font-semibold text-slate-800">
        {s.mth_price_title}
        <SectionInfo k="mth_price" lang={props.lang} />
      </h4>
      <div className="flex flex-wrap gap-4">
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mth_price_share}</span>
          <input className={control} inputMode="decimal" value={share} disabled={props.locked} onChange={(e) => setShare(e.target.value)} data-testid="price-share" />
        </label>
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mth_price_concession}</span>
          <input className={control} inputMode="decimal" value={concession} disabled={props.locked} onChange={(e) => setConcession(e.target.value)} data-testid="price-concession" />
        </label>
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mth_price_venue}</span>
          <input className={control} inputMode="decimal" value={venue} onChange={(e) => setVenue(e.target.value)} data-testid="price-venue" />
        </label>
        <label className="text-xs text-slate-600 space-y-1">
          <span className="block">{s.mth_price_payby}</span>
          <input className={`${control} w-52`} type="datetime-local" value={payBy} onChange={(e) => setPayBy(e.target.value)} data-testid="price-payby" />
        </label>
      </div>
      {suggestion !== null && (
        <p className="text-xs text-slate-600" data-testid="price-suggestion">
          {s.mth_price_suggest({ amount: pounds(suggestion) })}
        </p>
      )}
      {props.feeTip && (
        <p className="text-xs text-slate-500" data-testid="price-fee-tip">
          {props.feeTip}
        </p>
      )}
      {props.locked && (
        <p className="text-xs text-amber-700" data-testid="price-locked">
          {s.mth_price_locked}
        </p>
      )}
      <p className="text-xs text-slate-500">{s.mth_price_posts}</p>
      {error && (
        <p className="text-sm text-red-600" role="alert" data-testid="price-error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="h-9 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white disabled:opacity-40"
        disabled={saving}
        onClick={save}
        data-testid="price-save"
      >
        {props.priced ? s.mth_price_update : s.mth_price_save}
      </button>
    </div>
  );
}

/** The collector's own word on one regular's payment (D3). */
export function PaidButton(props: { orgId: string; monthId: string; userId: string; lang: string | null | undefined; confirmed: boolean }) {
  const s = t(props.lang);
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function set() {
    setSaving(true);
    try {
      const res = await setMonthPaid(props.orgId, props.monthId, props.userId, !props.confirmed);
      if (!res.ok) toast.error(s.mth_confirm_error({ key: res.error }));
      router.refresh();
    } catch {
      toast.error(s.mth_confirm_error({ key: "" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      disabled={saving}
      onClick={set}
      data-testid={props.confirmed ? "paid-undo" : "paid-confirm"}
    >
      {props.confirmed ? s.mth_unconfirm : s.mth_confirm}
    </button>
  );
}
