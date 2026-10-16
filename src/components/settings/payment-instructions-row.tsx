"use client";

/**
 * "Payment instructions" for a WEEKLY club that collects match fees
 * (Kemal, 2026-10-16), a row inside the Payments section of
 * /admin/settings. The same `Organisation.paymentInstructions` the
 * monthly squad section edits: a monthly club keeps editing it there and
 * the page does not render this row for it. Shown to players on the pay
 * page and in the pay link and daily chase when paying the collector
 * directly is offered (`directPayInstructions`). Saves through
 * `setMonthlySquad`, which trims, caps it at 500 characters and records
 * it as the organiser's own choice. Words from the club's language table,
 * with its ⓘ.
 */
import { useState } from "react";
import { toast } from "sonner";
import { setMonthlySquad, type MonthlySquadSettings } from "@/app/actions/squad-month";
import { SettingInfo } from "@/components/info/setting-info";
import { t } from "@/lib/i18n/t";
import { PAYMENT_INSTRUCTIONS_MAX } from "@/lib/squad-month-rules";

export function PaymentInstructionsRow(props: {
  orgId: string;
  language: string | null | undefined;
  initial: string | null;
  onSaved: (next: MonthlySquadSettings) => void;
}) {
  const s = t(props.language);
  const [text, setText] = useState(props.initial ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (text.trim().length > PAYMENT_INSTRUCTIONS_MAX) return setError(s.msq_err_long);
    setSaving(true);
    setError(null);
    try {
      const res = await setMonthlySquad(props.orgId, { paymentInstructions: text });
      if (!res.ok) {
        setError(res.error === "too-long" ? s.msq_err_long : s.wr_save_failed);
        return;
      }
      const { ok: _ok, ...next } = res;
      void _ok;
      setText(next.paymentInstructions ?? "");
      props.onSaved(next);
      toast.success(s.msq_saved);
    } catch {
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-setting="paymentInstructions" data-testid="pay-instructions-row">
      <div className="flex items-center gap-1 mb-1.5">
        <label htmlFor="pay-instructions" className="block text-sm font-medium text-slate-700">
          {s.msq_instructions_label}
        </label>
        <SettingInfo k="paymentInstructions" lang={props.language} />
      </div>
      <p className="text-xs text-slate-500">{s.pi_weekly_blurb}</p>
      <textarea
        id="pay-instructions"
        data-testid="pay-instructions-input"
        rows={3}
        maxLength={PAYMENT_INSTRUCTIONS_MAX}
        value={text}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        placeholder={s.msq_instructions_placeholder}
        className="mt-2 w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-50"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="pay-instructions-save"
          disabled={saving}
          onClick={() => void save()}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
        >
          {s.msq_save}
        </button>
      </div>
      {error && (
        <p role="alert" data-testid="pay-instructions-error" className="pt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
