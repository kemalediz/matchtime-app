"use client";

/**
 * "Who fills an open place" and "If nobody picks in time" on
 * /admin/settings "Weekly routine" (2026-10-01, slice 2b of
 * MDs/friday-group-features-plan-2026-09-30.md, section 5). Saved through
 * `setWeeklyRoutine` on change. The fallback row shows only when the
 * organisers pick. Words from the club's language table, each row with its
 * ⓘ.
 */
import { useState } from "react";
import { toast } from "sonner";
import { setWeeklyRoutine } from "@/app/actions/org";
import { InfoButton } from "@/components/stats/info-button";
import { t } from "@/lib/i18n/t";
import type { BenchPickFallback, BenchPickMode } from "@/lib/squad-capacity";

const control =
  "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-50 max-w-full";

export function PickModeRows(props: {
  orgId: string;
  language: string | null | undefined;
  benchPickMode: BenchPickMode;
  benchPickFallback: BenchPickFallback;
}) {
  const s = t(props.language);
  const [mode, setMode] = useState<BenchPickMode>(props.benchPickMode);
  const [fallback, setFallback] = useState<BenchPickFallback>(props.benchPickFallback);
  const [saving, setSaving] = useState(false);

  async function save(patch: { benchPickMode?: BenchPickMode; benchPickFallback?: BenchPickFallback }) {
    const before = { mode, fallback };
    if (patch.benchPickMode) setMode(patch.benchPickMode);
    if (patch.benchPickFallback) setFallback(patch.benchPickFallback);
    setSaving(true);
    try {
      const res = await setWeeklyRoutine(props.orgId, patch);
      if (!res.ok) throw new Error("refused");
      setMode(res.benchPickMode);
      setFallback(res.benchPickFallback);
      toast.success(s.wr_pick_saved);
    } catch {
      setMode(before.mode);
      setFallback(before.fallback);
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div id="wr-pick" className="py-3 scroll-mt-6" data-testid="wr-pick">
        <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
          {s.wr_pick_label}
          <InfoButton title={s.wr_pick_label}>
            <p>{s.wr_pick_info}</p>
          </InfoButton>
        </div>
        <p className="text-xs text-slate-500">{s.wr_pick_blurb}</p>
        <select
          aria-label={s.wr_pick_label}
          data-testid="wr-pick-mode"
          value={mode}
          disabled={saving}
          onChange={(e) => save({ benchPickMode: e.target.value as BenchPickMode })}
          className={`mt-2 ${control}`}
        >
          <option value="first-come">{s.wr_pick_first_come}</option>
          <option value="organiser">{s.wr_pick_organiser}</option>
        </select>
      </div>
      {mode === "organiser" && (
        <div className="py-3" data-testid="wr-fallback">
          <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
            {s.wr_fallback_label}
            <InfoButton title={s.wr_fallback_label}>
              <p>{s.wr_fallback_info}</p>
            </InfoButton>
          </div>
          <select
            aria-label={s.wr_fallback_label}
            data-testid="wr-fallback-mode"
            value={fallback}
            disabled={saving}
            onChange={(e) => save({ benchPickFallback: e.target.value as BenchPickFallback })}
            className={`mt-2 ${control}`}
          >
            <option value="bench-offer">{s.wr_fallback_offer}</option>
            <option value="leave-empty">{s.wr_fallback_leave}</option>
          </select>
        </div>
      )}
    </>
  );
}
