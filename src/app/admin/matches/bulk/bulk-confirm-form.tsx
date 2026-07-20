"use client";

/**
 * Tick-list + explicit confirm for bulk cancel/restore. Cancel mode is
 * SILENT by default — the "announce to the group" checkbox is opt-in and
 * clearly labelled; restore has no announce option (always silent).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Undo2, XCircle } from "lucide-react";
import { formatLondon } from "@/lib/london-time";
import {
  bulkCancelMatches,
  bulkRestoreMatches,
} from "@/app/actions/block-bookings";

interface Row {
  id: string;
  dateIso: string;
  status: string;
  activityName: string;
  venue: string;
  confirmedCount: number;
}

export function BulkConfirmForm({
  mode,
  matches,
}: {
  mode: "cancel" | "restore";
  matches: Row[];
}) {
  const router = useRouter();
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(matches.map((m) => m.id)),
  );
  const [announce, setAnnounce] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (matches.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500">
        No {mode === "cancel" ? "cancellable" : "restorable"} matches in that
        range.
      </div>
    );
  }

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirm() {
    const ids = [...checked];
    if (ids.length === 0) return toast.error("Nothing selected");
    setSubmitting(true);
    try {
      if (mode === "cancel") {
        const res = await bulkCancelMatches({ matchIds: ids, announce });
        toast.success(
          `${res.cancelled} matches cancelled` +
            (res.announced
              ? " — one announcement queued for the group."
              : " — silently, no group message."),
        );
      } else {
        const res = await bulkRestoreMatches({ matchIds: ids });
        toast.success(`${res.restored} matches restored (no group message).`);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setSubmitting(false);
    }
  }

  const verb = mode === "cancel" ? "Cancel" : "Restore";

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100">
      <div className="px-6 py-4">
        <p className="font-medium text-slate-800">
          {matches.length} match{matches.length === 1 ? "" : "es"} found —{" "}
          {checked.size} selected
        </p>
      </div>

      {matches.map((m) => (
        <label
          key={m.id}
          className="px-6 py-3 flex items-center gap-3 hover:bg-slate-50 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={checked.has(m.id)}
            onChange={() => toggle(m.id)}
            className="w-4 h-4"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-800">
              {formatLondon(new Date(m.dateIso), "EEE d MMM yyyy, HH:mm")} ·{" "}
              {m.activityName}
            </p>
            <p className="text-xs text-slate-400">
              {m.venue} · {m.status}
              {m.confirmedCount > 0 && (
                <span className="text-amber-600">
                  {" "}· {m.confirmedCount} player{m.confirmedCount === 1 ? "" : "s"} already IN
                </span>
              )}
            </p>
          </div>
        </label>
      ))}

      <div className="px-6 py-4 space-y-3">
        {mode === "cancel" && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={announce}
              onChange={(e) => setAnnounce(e.target.checked)}
              className="w-4 h-4"
            />
            Announce to the group (one summary message).{" "}
            <span className="text-slate-400">
              Off = completely silent — nothing is posted.
            </span>
          </label>
        )}
        <button
          onClick={handleConfirm}
          disabled={submitting || checked.size === 0}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-white font-medium disabled:opacity-60 disabled:cursor-not-allowed ${
            mode === "cancel"
              ? "bg-red-600 hover:bg-red-700"
              : "bg-green-600 hover:bg-green-700"
          }`}
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : mode === "cancel" ? (
            <XCircle className="w-4 h-4" />
          ) : (
            <Undo2 className="w-4 h-4" />
          )}
          {verb} {checked.size} match{checked.size === 1 ? "" : "es"}
          {mode === "cancel" && !announce ? " (silent)" : ""}
        </button>
      </div>
    </div>
  );
}
