"use client";

/**
 * "Monthly squad" on /admin/settings (2026-10-05, slice 2 of
 * MDs/monthly-squad-plan-2026-10-05.md, section 9.1). OWNER and ADMIN.
 *
 * One switch, off by default: how the squad works, weekly (today) or
 * monthly. A weekly club sees the switch and nothing else. Once monthly,
 * the rest appear: the PAYG price, when the list opens, the credit rule
 * and the collector's free-text payment instructions.
 *
 * The two selects save on change; the three typed fields share one Save.
 * Everything goes through `setMonthlySquad`, which refuses a bad value
 * with a reason this component puts into words. Words come from the
 * club's language table, each control with its ⓘ.
 */
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarDays } from "lucide-react";
import { setMonthlySquad, type MonthlySquadSettings } from "@/app/actions/squad-month";
import { SectionInfo } from "@/components/info/section-info";
import { t } from "@/lib/i18n/t";
import {
  LIST_OPENS_DAYS_MAX,
  LIST_OPENS_DAYS_MIN,
  PAYMENT_INSTRUCTIONS_MAX,
  parsePounds,
  poundsText,
  type MonthCreditRule,
  type MonthlySquadPatch,
  type SquadMode,
} from "@/lib/squad-month-rules";

export type MonthlySquadData = Omit<MonthlySquadSettings, "rollingSquad">;

const control =
  "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-50 max-w-full";

export function MonthlySquadSection(props: {
  orgId: string;
  language: string | null | undefined;
  initial: MonthlySquadData;
  /** After every save: the page keeps its own copy (it hides the rolling squad row for a monthly club). */
  onSaved: (next: MonthlySquadSettings) => void;
}) {
  const s = t(props.language);
  const lang = props.language;
  const [saved, setSaved] = useState<MonthlySquadData>(props.initial);
  const [price, setPrice] = useState(poundsText(props.initial.paygPricePence));
  const [days, setDays] = useState(String(props.initial.monthListOpensDaysBefore));
  const [instructions, setInstructions] = useState(props.initial.paymentInstructions ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const monthly = saved.squadMode === "monthly";

  async function save(patch: MonthlySquadPatch, done: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await setMonthlySquad(props.orgId, patch);
      if (!res.ok) {
        setError(
          res.error === "bad-price" ? s.msq_err_price : res.error === "bad-days" ? s.msq_err_days : res.error === "too-long" ? s.msq_err_long : s.wr_save_failed,
        );
        return;
      }
      const { ok: _ok, ...next } = res;
      void _ok;
      setSaved(next);
      setPrice(poundsText(next.paygPricePence));
      setDays(String(next.monthListOpensDaysBefore));
      setInstructions(next.paymentInstructions ?? "");
      props.onSaved(next);
      toast.success(done);
    } catch {
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  function saveFields() {
    const pence = price.trim() === "" ? null : parsePounds(price);
    if (price.trim() !== "" && pence === null) return setError(s.msq_err_price);
    const n = Number(days);
    if (!/^\d+$/.test(days.trim()) || n < LIST_OPENS_DAYS_MIN || n > LIST_OPENS_DAYS_MAX) return setError(s.msq_err_days);
    if (instructions.trim().length > PAYMENT_INSTRUCTIONS_MAX) return setError(s.msq_err_long);
    void save({ paygPricePence: pence, monthListOpensDaysBefore: n, paymentInstructions: instructions }, s.msq_saved);
  }

  const label = "flex items-center gap-1 text-sm font-medium text-slate-800";

  return (
    <section id="monthly-squad" className="bg-white rounded-xl border border-slate-200 shadow-sm scroll-mt-6" data-testid="monthly-squad">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <CalendarDays className="w-4 h-4 text-slate-500" />
        <h2 className="font-semibold text-slate-800">{s.msq_section_title}</h2>
        <SectionInfo k="st_monthly" lang={lang} />
      </div>
      <div className="p-6">
        <p className="text-sm text-slate-500 mb-4">{s.msq_section_lead}</p>
        <div className="divide-y divide-slate-100">
          <div className="py-3">
            <div className={label}>
              {s.msq_mode_label}
              <SectionInfo k="msq_mode" lang={lang} />
            </div>
            <p className="text-xs text-slate-500">{s.msq_mode_blurb}</p>
            <select
              aria-label={s.msq_mode_label}
              data-testid="msq-mode"
              value={saved.squadMode}
              disabled={saving}
              onChange={(e) => {
                const squadMode = e.target.value as SquadMode;
                void save({ squadMode }, squadMode === "monthly" ? s.msq_switched_monthly : s.msq_switched_weekly);
              }}
              className={`mt-2 ${control}`}
            >
              <option value="weekly">{s.msq_mode_weekly}</option>
              <option value="monthly">{s.msq_mode_monthly}</option>
            </select>
            {monthly && (
              <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900 space-y-1" data-testid="msq-notes">
                <p>{s.msq_rolling_note}</p>
                <p>
                  <Link href="/admin/months" className="font-medium underline" data-testid="msq-months-link">
                    {s.msq_months_link}
                  </Link>
                </p>
              </div>
            )}
          </div>

          {monthly && (
            <>
              <div className="py-3" data-testid="msq-credit">
                <div className={label}>
                  {s.msq_credit_label}
                  <SectionInfo k="msq_credit" lang={lang} />
                </div>
                <p className="text-xs text-slate-500">{s.msq_credit_blurb}</p>
                <select
                  aria-label={s.msq_credit_label}
                  data-testid="msq-credit-rule"
                  value={saved.monthCreditRule}
                  disabled={saving}
                  onChange={(e) => void save({ monthCreditRule: e.target.value as MonthCreditRule }, s.msq_saved)}
                  className={`mt-2 ${control}`}
                >
                  <option value="any-miss">{s.msq_credit_any}</option>
                  <option value="filled-only">{s.msq_credit_filled}</option>
                  <option value="none">{s.msq_credit_none}</option>
                </select>
              </div>

              <div className="py-3">
                <div className={label}>
                  <label htmlFor="msq-payg">{s.msq_payg_label}</label>
                  <SectionInfo k="msq_payg" lang={lang} />
                </div>
                <p className="text-xs text-slate-500">{s.msq_payg_blurb}</p>
                <input
                  id="msq-payg"
                  data-testid="msq-payg"
                  inputMode="decimal"
                  value={price}
                  disabled={saving}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="8.00"
                  className={`mt-2 w-28 ${control}`}
                />
              </div>

              <div className="py-3">
                <div className={label}>
                  <label htmlFor="msq-opens">{s.msq_opens_label}</label>
                  <SectionInfo k="msq_opens" lang={lang} />
                </div>
                <p className="text-xs text-slate-500">{s.msq_opens_blurb}</p>
                <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                  <input
                    id="msq-opens"
                    data-testid="msq-opens"
                    inputMode="numeric"
                    value={days}
                    disabled={saving}
                    onChange={(e) => setDays(e.target.value)}
                    className={`w-20 ${control}`}
                  />
                  <span>{s.msq_opens_unit}</span>
                </div>
              </div>

              <div className="py-3">
                <div className={label}>
                  <label htmlFor="msq-instructions">{s.msq_instructions_label}</label>
                  <SectionInfo k="msq_instructions" lang={lang} />
                </div>
                <p className="text-xs text-slate-500">{s.msq_instructions_blurb}</p>
                <textarea
                  id="msq-instructions"
                  data-testid="msq-instructions"
                  rows={3}
                  maxLength={PAYMENT_INSTRUCTIONS_MAX}
                  value={instructions}
                  disabled={saving}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={s.msq_instructions_placeholder}
                  className="mt-2 w-full max-w-xl px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-50"
                />
              </div>

              <div className="pt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="msq-save"
                  disabled={saving}
                  onClick={saveFields}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
                >
                  {s.msq_save}
                </button>
              </div>
            </>
          )}
          {error && (
            <p role="alert" data-testid="msq-error" className="pt-3 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
