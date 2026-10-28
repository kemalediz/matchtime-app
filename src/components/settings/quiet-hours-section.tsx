"use client";

/**
 * "Quiet hours" (2026-10-16), its own card on /admin/settings: whether
 * MatchTime holds the club's messages during quiet hours, and From and To
 * (London). Default ON, 23:00 to 09:00. Words from the club's language
 * table, with its ⓘ. Loads and saves through its own server actions
 * (`app/actions/quiet-hours.ts`), so the page only renders it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Moon } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { t } from "@/lib/i18n/t";
import { getQuietHours, setQuietHours } from "@/app/actions/quiet-hours";
import type { QuietHours } from "@/lib/message-hours";
import { quietHoursSummary } from "@/lib/settings-summaries";
import { SettingsCard } from "./settings-nav";

export function QuietHoursSection(props: { orgId: string; language: string | null | undefined }) {
  const s = t(props.language);
  const [saved, setSaved] = useState<QuietHours | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getQuietHours(props.orgId)
      .then((q) => {
        setSaved(q);
        if (q) {
          setFrom(q.from);
          setTo(q.to);
        }
      })
      .catch(() => setSaved(null));
  }, [props.orgId]);

  if (!saved) return null;
  const on = saved.enabled;

  async function save(next: { enabled: boolean; from?: string; to?: string }) {
    setSaving(true);
    setError(null);
    try {
      const res = await setQuietHours(props.orgId, next);
      if (!res.ok) {
        setError(s.qh_settings_bad_time);
        return;
      }
      setSaved(res.value);
      setFrom(res.value.from);
      setTo(res.value.to);
      toast.success(s.qh_settings_saved);
    } catch {
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  const saveTimes = () => {
    if (!on || !from || !to) return;
    if (from === saved.from && to === saved.to) return;
    void save({ enabled: true, from, to });
  };

  const control =
    "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50";

  return (
    <SettingsCard
      id="quiet-hours"
      title={s.qh_settings_label}
      icon={Moon}
      info={<SettingInfo k="quietHours" lang={props.language} />}
      summary={quietHoursSummary(props.language, saved)}
      testId="quiet-hours"
      rootProps={{ "data-setting": "quietHours" }}
    >
      <div className="p-4 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-slate-500">{s.qh_settings_blurb}</p>
          <button
            role="switch"
            aria-checked={on}
            aria-label={s.qh_settings_label}
            data-testid="quiet-hours-switch"
            disabled={saving}
            onClick={() => save(on ? { enabled: false } : { enabled: true, from: from || saved.from, to: to || saved.to })}
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-green-500" : "bg-slate-300"}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`}
            />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            {s.qh_settings_from}
            <input
              type="time"
              aria-label={s.qh_settings_from}
              data-testid="quiet-hours-from"
              value={from}
              disabled={saving || !on}
              onChange={(e) => setFrom(e.target.value)}
              onBlur={saveTimes}
              className={control}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            {s.qh_settings_to}
            <input
              type="time"
              aria-label={s.qh_settings_to}
              data-testid="quiet-hours-to"
              value={to}
              disabled={saving || !on}
              onChange={(e) => setTo(e.target.value)}
              onBlur={saveTimes}
              className={control}
            />
          </label>
        </div>
        {!on && (
          <p className="text-xs text-slate-500" data-testid="quiet-hours-off-note">
            {s.qh_settings_off_note}
          </p>
        )}
        {error && (
          <p className="text-xs text-red-600" data-testid="quiet-hours-error">
            {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
