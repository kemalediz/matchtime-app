"use client";

/**
 * "4 only" (2026-10-29) on a regular's own /month page: how many of the
 * month's games they are playing. Before the month's first game, and
 * before they have paid; after that the organiser changes it.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setMyMonthGames } from "@/app/actions/month-signup";
import { monthSetupCopy } from "@/lib/i18n/month-setup";

export function MyGamesCard(props: { monthId: string; lang: string | null | undefined; of: number; committed: number | null }) {
  const c = monthSetupCopy(props.lang);
  const router = useRouter();
  const [value, setValue] = useState(props.committed != null ? String(props.committed) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: string) {
    setValue(next);
    setError(null);
    setSaving(true);
    try {
      const res = await setMyMonthGames(props.monthId, next === "" ? null : Number(next));
      if (!res.ok) return setError(c.games_error({ key: res.error }));
      toast.success(c.games_saved);
      router.refresh();
    } catch {
      setError(c.games_error({ key: "failed" }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2" data-testid="my-games">
      <label className="block text-sm font-medium text-slate-800" htmlFor={`my-games-${props.monthId}`}>
        {c.my_games_label({ of: props.of })}
      </label>
      <select
        id={`my-games-${props.monthId}`}
        data-testid="my-games-select"
        value={value}
        disabled={saving}
        onChange={(e) => choose(e.target.value)}
        className="h-9 px-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-700"
      >
        <option value="">{c.my_games_all({ of: props.of })}</option>
        {Array.from({ length: Math.max(0, props.of - 1) }, (_, i) => props.of - 1 - i).map((n) => (
          <option key={n} value={String(n)}>
            {n}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" data-testid="my-games-error" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
