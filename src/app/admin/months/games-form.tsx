"use client";

/**
 * "4 only" (2026-10-29) on /admin/months: how many of the month's games a
 * regular commits to. Blank is every game. Saving works out what they owe
 * again at once (`setMonthMemberGames`); the server refuses more games
 * than the month has, in words this form shows.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setMemberGames } from "@/app/actions/squad-month";
import { monthSetupCopy } from "@/lib/i18n/month-setup";

export function MemberGamesForm(props: {
  orgId: string;
  monthId: string;
  userId: string;
  lang: string | null | undefined;
  covered: number;
  committed: number | null;
  /** A closed month is read only. */
  readOnly: boolean;
}) {
  const c = monthSetupCopy(props.lang);
  const router = useRouter();
  const [value, setValue] = useState(props.committed != null ? String(props.committed) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = props.committed != null ? c.games_of({ games: props.committed, of: props.covered }) : String(props.covered);
  if (props.readOnly) return <span data-testid="member-games">{shown}</span>;
  const changed = value.trim() !== (props.committed != null ? String(props.committed) : "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = value.trim();
    const games = text === "" ? null : /^\d+$/.test(text) ? Number(text) : NaN;
    if (games !== null && !Number.isInteger(games)) return setError(c.games_error({ key: "bad-games" }));
    setSaving(true);
    try {
      const res = await setMemberGames(props.orgId, props.monthId, props.userId, games);
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
    <form onSubmit={save} className="flex items-center gap-1.5" data-testid="member-games-form">
      <span data-testid="member-games" className="whitespace-nowrap">
        {shown}
      </span>
      <input
        aria-label={c.col_games_committed}
        data-testid="member-games-input"
        inputMode="numeric"
        value={value}
        placeholder={c.games_all}
        onChange={(e) => setValue(e.target.value)}
        className="h-8 w-12 px-1.5 rounded-md border border-slate-200 bg-white text-sm text-slate-700"
      />
      {changed && (
        <button
          type="submit"
          data-testid="member-games-save"
          disabled={saving}
          className="px-2 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-100 text-xs font-medium text-slate-700 disabled:opacity-50"
        >
          {c.games_save}
        </button>
      )}
      {error && (
        <span role="alert" data-testid="member-games-error" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </form>
  );
}
