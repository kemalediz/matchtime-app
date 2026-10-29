"use client";

/**
 * A3 (2026-10-29) on /admin/months: the months the club plays no games in
 * ("no football in December"). For a ticked month no list opens, no month
 * or match is made and nothing is posted (`setSeasonBreak`).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveSeasonBreak } from "@/app/actions/squad-month";
import { monthSetupCopy } from "@/lib/i18n/month-setup";

export function SeasonBreakForm(props: {
  orgId: string;
  lang: string | null | undefined;
  /** The months that can be ticked, in order: "YYYY-MM" with its label. */
  months: Array<{ key: string; label: string }>;
  ticked: string[];
}) {
  const c = monthSetupCopy(props.lang);
  const router = useRouter();
  const [ticked, setTicked] = useState<string[]>(props.ticked);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = (key: string) => props.months.find((m) => m.key === key)?.label ?? key;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    setSaving(true);
    try {
      const res = await saveSeasonBreak(props.orgId, ticked);
      if (!res.ok) return setError(c.break_error({ key: res.error, month: res.month ? label(res.month) : undefined }));
      toast.success(c.break_saved);
      if (res.keptGames > 0) setNote(c.break_kept_games({ count: res.keptGames }));
      router.refresh();
    } catch {
      setError(c.break_error({ key: "failed" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-3" data-testid="season-break">
      <h3 className="font-semibold text-slate-800">{c.break_title}</h3>
      <p className="text-sm text-slate-500 max-w-2xl">{c.break_body}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {props.months.map((m) => (
          <label key={m.key} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              data-testid="season-break-month"
              data-month={m.key}
              checked={ticked.includes(m.key)}
              onChange={(e) => setTicked((prev) => (e.target.checked ? [...prev, m.key] : prev.filter((x) => x !== m.key)))}
              className="h-4 w-4 rounded border-slate-300"
            />
            {m.label}
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" data-testid="season-break-error" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {note && (
        <p data-testid="season-break-note" className="text-sm text-amber-800">
          {note}
        </p>
      )}
      <button
        type="submit"
        data-testid="season-break-save"
        disabled={saving}
        className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
      >
        {c.break_save}
      </button>
    </form>
  );
}
