"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleSlash, RotateCcw } from "lucide-react";
import { cancelMatch, restorePlayedMatch } from "@/app/actions/matches";
import { t } from "@/lib/i18n/t";

/**
 * "This game didn't happen" on a past match's page (2026-10-28, Kemal), for
 * an organiser, inside the 7-day window (`notPlayedDoor`). One tap opens a
 * confirm step in place; the yes calls the one cancel core through
 * `cancelMatch`, and the reply it returns (who had paid, to refund or
 * credit) is shown as a toast. On a game already marked, "It did happen"
 * puts it back on the record as played.
 */
export function NotPlayedButton({
  matchId,
  lang,
  mode,
  game,
}: {
  matchId: string;
  lang: string;
  mode: "mark" | "restore";
  /** "Tuesday 5-a-side on 27 Oct", from `notPlayedGameLabel`. */
  game: string;
}) {
  const s = t(lang);
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const r = mode === "mark" ? await cancelMatch(matchId) : await restorePlayedMatch(matchId);
      if (r.message) toast.success(r.message, { duration: 10_000 });
      setConfirming(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        data-testid={mode === "mark" ? "not-played-button" : "played-restore-button"}
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
      >
        {mode === "mark" ? <CircleSlash className="w-4 h-4" /> : <RotateCcw className="w-4 h-4" />}
        {mode === "mark" ? s.not_played_button : s.not_played_restore_button}
      </button>
    );
  }

  return (
    <div data-testid="not-played-confirm" className="w-full rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
      <p className="text-sm text-amber-900">{mode === "mark" ? s.not_played_confirm({ game }) : s.not_played_restore_confirm({ game })}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          data-testid="not-played-yes"
          onClick={confirm}
          disabled={busy}
          className="inline-flex justify-center items-center px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium disabled:opacity-60"
        >
          {mode === "mark" ? s.not_played_yes : s.not_played_restore_yes}
        </button>
        <button
          type="button"
          data-testid="not-played-keep"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="inline-flex justify-center items-center px-4 py-2 rounded-lg text-slate-700 hover:bg-white font-medium"
        >
          {s.not_played_keep}
        </button>
      </div>
    </div>
  );
}
