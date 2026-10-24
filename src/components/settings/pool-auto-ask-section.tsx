"use client";

/**
 * "Ask the player pool automatically" (pool slice L9, 2026-10-24), its own
 * card on /admin/settings beside Style of play: one switch, off by default.
 * Renders nothing unless the club may ask the player pool. Loads and saves
 * through its own server actions (`app/actions/pool-auto-ask.ts`), so the
 * page only renders it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { SettingInfo } from "@/components/info/setting-info";
import { t } from "@/lib/i18n/t";
import { getPoolAutoAsk, setPoolAutoAsk } from "@/app/actions/pool-auto-ask";

export function PoolAutoAskSection(props: { orgId: string; language: string | null | undefined }) {
  const s = t(props.language);
  const [on, setOn] = useState<boolean | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPoolAutoAsk(props.orgId)
      .then((r) => setOn(r ? r.on : undefined))
      .catch(() => setOn(undefined));
  }, [props.orgId]);

  if (on === undefined) return null;

  async function save(next: boolean) {
    setSaving(true);
    try {
      const res = await setPoolAutoAsk(props.orgId, next);
      if (!res.ok) {
        toast.error(s.wr_save_failed);
        return;
      }
      setOn(res.on);
      toast.success(s.pauto_saved({ on: res.on }));
    } catch {
      toast.error(s.wr_save_failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm" data-testid="pool-auto-ask" data-setting="poolAutoAsk">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-slate-500" aria-hidden />
        <h2 className="font-semibold text-slate-800">{s.pauto_title}</h2>
        <SettingInfo k="poolAutoAsk" lang={props.language} />
      </div>
      <div className="p-6 flex items-start justify-between gap-4">
        <p className="text-sm text-slate-500" id="pool-auto-ask-blurb">
          {s.pauto_blurb}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={s.pauto_title}
          aria-describedby="pool-auto-ask-blurb"
          data-testid="pool-auto-ask-switch"
          disabled={saving}
          onClick={() => void save(!on)}
          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-green-500" : "bg-slate-300"}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`} />
        </button>
      </div>
    </section>
  );
}
