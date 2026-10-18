"use client";

/**
 * "Man of the Match chosen by" on /admin/settings, Bot features
 * (2026-10-18, mom-chooser.ts). Saved through `setWeeklyRoutine` on
 * change, like the list announcer row. Words from the club's language
 * table, with its ⓘ.
 */
import { useState } from "react";
import { toast } from "sonner";
import { setWeeklyRoutine } from "@/app/actions/org";
import { SettingInfo } from "@/components/info/setting-info";
import { t } from "@/lib/i18n/t";
import type { MomChooser } from "@/lib/mom-chooser";

const control =
  "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-50 max-w-full";

export function MomChooserRow(props: { orgId: string; language: string | null | undefined; momChosenBy: MomChooser }) {
  const s = t(props.language);
  const [value, setValue] = useState<MomChooser>(props.momChosenBy);
  const [saving, setSaving] = useState(false);

  async function save(next: MomChooser) {
    const before = value;
    setValue(next);
    setSaving(true);
    try {
      const res = await setWeeklyRoutine(props.orgId, { momChosenBy: next });
      if (!res.ok) throw new Error("refused");
      setValue(res.momChosenBy);
      toast.success(s.wr_pick_saved);
    } catch {
      setValue(before);
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="py-3" data-testid="mom-chooser" data-setting="momChosenBy">
      <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
        {s.mom_chooser_label}
        <SettingInfo k="momChosenBy" lang={props.language} />
      </div>
      <p className="text-xs text-slate-500">{s.mom_chooser_blurb}</p>
      <select
        aria-label={s.mom_chooser_label}
        data-testid="mom-chooser-mode"
        value={value}
        disabled={saving}
        onChange={(e) => save(e.target.value as MomChooser)}
        className={`mt-2 ${control}`}
      >
        <option value="players">{s.mom_chooser_players}</option>
        <option value="organisers">{s.mom_chooser_organisers}</option>
      </select>
    </div>
  );
}
