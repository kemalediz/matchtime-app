"use client";

/**
 * "Who announces the list and teams" on /admin/settings "Weekly routine"
 * (2026-10-14, list-announcer.ts). Saved through `setWeeklyRoutine` on
 * change, like the pick rows beside it. Words from the club's language
 * table, with its ⓘ.
 */
import { useState } from "react";
import { toast } from "sonner";
import { setWeeklyRoutine } from "@/app/actions/org";
import { InfoButton } from "@/components/stats/info-button";
import { t } from "@/lib/i18n/t";
import { LEARNED_REFRESH_EVENT } from "@/lib/setup-learning/suggestion-state";
import type { ListAnnouncer } from "@/lib/list-announcer";

const control =
  "h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 disabled:opacity-50 max-w-full";

export function ListAnnouncerRow(props: {
  orgId: string;
  language: string | null | undefined;
  listAnnouncer: ListAnnouncer;
  /** Called after a save has been stored (the Go live banner's preview). */
  onSaved?: () => void;
}) {
  const s = t(props.language);
  const [value, setValue] = useState<ListAnnouncer>(props.listAnnouncer);
  const [saving, setSaving] = useState(false);

  async function save(next: ListAnnouncer) {
    const before = value;
    setValue(next);
    setSaving(true);
    try {
      const res = await setWeeklyRoutine(props.orgId, { listAnnouncer: next });
      if (!res.ok) throw new Error("refused");
      setValue(res.listAnnouncer);
      toast.success(s.wr_pick_saved);
      window.dispatchEvent(new Event(LEARNED_REFRESH_EVENT));
      props.onSaved?.();
    } catch {
      setValue(before);
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="wr-announce" className="py-3 scroll-mt-6" data-testid="wr-announce">
      <div className="flex items-center gap-1 text-sm font-medium text-slate-800">
        {s.wr_announce_label}
        <InfoButton title={s.wr_announce_label}>
          <p>{s.wr_announce_info}</p>
        </InfoButton>
      </div>
      <p className="text-xs text-slate-500">{s.wr_announce_blurb}</p>
      <select
        aria-label={s.wr_announce_label}
        data-testid="wr-announce-mode"
        value={value}
        disabled={saving}
        onChange={(e) => save(e.target.value as ListAnnouncer)}
        className={`mt-2 ${control}`}
      >
        <option value="matchtime">{s.wr_announce_matchtime}</option>
        <option value="organisers">{s.wr_announce_organisers}</option>
      </select>
    </div>
  );
}
