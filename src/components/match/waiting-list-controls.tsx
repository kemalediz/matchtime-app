"use client";

/**
 * The waiting list on the match page for an organiser-pick club (slice 2b,
 * plan 2.13), admins only: each player's position and club rating, arrows
 * to reorder, and "Bring in". Reorder rewrites BENCH positions only; Bring
 * in goes through the same writer as a reply in the admin channel. Words
 * from the club's language table.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, UserPlus } from "lucide-react";
import { pickFromWaitingList, reorderWaitingList } from "@/app/actions/players";
import { t } from "@/lib/i18n/t";

export interface WaitingListRow {
  userId: string;
  name: string;
  position: string | null;
  rating: number | null;
}

export function WaitingListControls(props: { matchId: string; lang: string | null | undefined; rows: WaitingListRow[] }) {
  const s = t(props.lang);
  const router = useRouter();
  const [rows, setRows] = useState(props.rows);
  const [busy, setBusy] = useState(false);

  async function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    const before = rows;
    setRows(next);
    setBusy(true);
    try {
      await reorderWaitingList(props.matchId, next.map((r) => r.userId));
      router.refresh();
    } catch {
      setRows(before);
      toast.error(s.wl_failed);
    } finally {
      setBusy(false);
    }
  }

  async function bringIn(row: WaitingListRow) {
    setBusy(true);
    try {
      const res = await pickFromWaitingList(props.matchId, row.userId);
      if (res.brought) toast.success(s.wl_brought_in({ name: row.name }));
      else toast.error(res.full ? s.wl_full : s.wl_failed);
      router.refresh();
    } catch {
      toast.error(s.wl_failed);
    } finally {
      setBusy(false);
    }
  }

  if (rows.length === 0) return null;
  return (
    <div className="pt-6 border-t border-slate-100" data-testid="waiting-list">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">{s.wl_title({ count: rows.length })}</h3>
      <p className="text-xs text-slate-400 mb-3">{s.wl_hint}</p>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.userId} className="flex items-center gap-2 py-1" data-testid="waiting-list-row">
            <span className="text-xs text-slate-400 w-5 text-right font-mono">{i + 1}</span>
            <span className="text-sm text-slate-800 truncate min-w-0">{r.name}</span>
            <span className="text-[11px] text-slate-500 shrink-0">
              {r.position ?? s.wl_no_position}, {r.rating === null ? s.wl_new : r.rating.toFixed(1)}
            </span>
            <span className="ml-auto flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={`${s.wl_move_up}: ${r.name}`}
                disabled={busy || i === 0}
                onClick={() => move(i, -1)}
                className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-600 disabled:opacity-30"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label={`${s.wl_move_down}: ${r.name}`}
                disabled={busy || i === rows.length - 1}
                onClick={() => move(i, 1)}
                className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-600 disabled:opacity-30"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="waiting-list-bring-in"
                disabled={busy}
                onClick={() => bringIn(r)}
                className="inline-flex items-center gap-1 px-2 h-7 rounded-md text-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-[11px] font-semibold disabled:opacity-50"
              >
                <UserPlus className="w-3.5 h-3.5" /> {s.wl_bring_in}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
