"use client";

/**
 * "Teams ready" (2026-10-14), a row inside the "Weekly routine" section of
 * /admin/settings: when MatchTime proposes the teams in the club's admin
 * group on match day. A London time, or Off. Shown only for a weekly club
 * with an admin group linked, the only clubs it does anything for. Words
 * from the club's language table, with its ⓘ. Loads and saves through
 * its own server actions (`app/actions/teams-ready.ts`), so the page only
 * renders it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { InfoButton } from "@/components/stats/info-button";
import { t } from "@/lib/i18n/t";
import { getTeamsReady, setTeamsReady, type TeamsReadyStatus } from "@/app/actions/teams-ready";

export function TeamsReadyRow(props: { orgId: string; language: string | null | undefined }) {
  const s = t(props.language);
  const [status, setStatus] = useState<TeamsReadyStatus | null>(null);
  const [time, setTime] = useState("");
  const [off, setOff] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTeamsReady(props.orgId)
      .then((st) => {
        setStatus(st);
        if (st) {
          setOff(st.value === "off");
          setTime(st.value === "off" ? "10:00" : st.value);
        }
      })
      .catch(() => setStatus(null));
  }, [props.orgId]);

  if (!status || !status.adminGroupLinked || !status.weekly) return null;

  async function save(next: string) {
    const wasOff = off;
    // Shown at once; put back if the save does not land.
    setOff(next === "off");
    setSaving(true);
    setError(null);
    try {
      const res = await setTeamsReady(props.orgId, next);
      if (!res.ok) {
        setOff(wasOff);
        setError(s.tp_settings_bad_time);
        return;
      }
      setOff(res.value === "off");
      if (res.value !== "off") setTime(res.value);
      setStatus((prev) => (prev ? { ...prev, value: res.value } : prev));
      toast.success(s.tp_settings_saved);
    } catch {
      setOff(wasOff);
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  const control =
    "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50";

  return (
    <div className="py-3" data-testid="teams-ready">
      <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
        {s.tp_settings_label}
        <InfoButton title={s.tp_settings_label}>
          <p>{s.tp_settings_info}</p>
        </InfoButton>
      </div>
      <p className="text-xs text-slate-500">{s.tp_settings_blurb}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          type="time"
          aria-label={s.tp_settings_label}
          data-testid="teams-ready-time"
          value={time}
          disabled={saving || off}
          onChange={(e) => setTime(e.target.value)}
          onBlur={() => !off && time && time !== status.value && save(time)}
          className={control}
        />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            data-testid="teams-ready-off"
            checked={off}
            disabled={saving}
            onChange={(e) => save(e.target.checked ? "off" : time || "10:00")}
          />
          {s.tp_settings_off}
        </label>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
