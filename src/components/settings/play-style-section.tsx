"use client";

/**
 * "Style of play" (pool slice L5b, 2026-10-24), its own card on
 * /admin/settings: casual, competitive, mixed or not set, shown on offers to
 * pool players. Renders nothing unless the club may ask the player pool.
 * Loads and saves through its own server actions (`app/actions/play-style.ts`),
 * so the page only renders it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Gauge } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { t } from "@/lib/i18n/t";
import { getPlayStyle, setPlayStyle } from "@/app/actions/play-style";
import { PLAY_STYLES, type PlayStyle } from "@/lib/pool/vocab";

export function PlayStyleSection(props: { orgId: string; language: string | null | undefined }) {
  const s = t(props.language);
  const [value, setValue] = useState<PlayStyle | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPlayStyle(props.orgId)
      .then((r) => setValue(r ? r.value : undefined))
      .catch(() => setValue(undefined));
  }, [props.orgId]);

  if (value === undefined) return null;

  async function save(next: string) {
    setSaving(true);
    try {
      const res = await setPlayStyle(props.orgId, next);
      if (!res.ok) {
        toast.error(s.wr_save_failed);
        return;
      }
      setValue(res.value);
      toast.success(s.ps_saved);
    } catch {
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm" data-testid="play-style" data-setting="playStyle">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Gauge className="w-4 h-4 text-slate-500" aria-hidden />
        <h2 className="font-semibold text-slate-800">{s.ps_title}</h2>
        <SettingInfo k="playStyle" lang={props.language} />
      </div>
      <div className="p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-sm text-slate-500" id="play-style-blurb">
          {s.ps_blurb}
        </p>
        <select
          aria-label={s.ps_title}
          aria-describedby="play-style-blurb"
          data-testid="play-style-select"
          value={value ?? ""}
          disabled={saving}
          onChange={(e) => void save(e.target.value)}
          className="h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <option value="">{s.ps_style({ kind: "" })}</option>
          {PLAY_STYLES.map((k) => (
            <option key={k} value={k}>
              {s.ps_style({ kind: k })}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
