"use client";

/**
 * Per-block quick actions: silent cancel of the block's remaining future
 * matches, silent restore of its cancelled future matches, and delete
 * (with an explicit confirm that explains history is never destroyed).
 * All destructive paths require a confirm step; none of them posts to
 * the group.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Trash2, Undo2, XCircle } from "lucide-react";
import {
  bulkCancelMatches,
  bulkRestoreMatches,
  deleteBlockBooking,
} from "@/app/actions/block-bookings";

interface BlockMatch {
  id: string;
  dateIso: string;
  status: string;
}

export function BlockActions({
  blockId,
  matches,
}: {
  blockId: string;
  matches: BlockMatch[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<
    "cancel" | "restore" | "delete" | null
  >(null);

  const now = Date.now();
  const futureLive = matches.filter(
    (m) =>
      new Date(m.dateIso).getTime() > now &&
      (m.status === "UPCOMING" ||
        m.status === "TEAMS_GENERATED" ||
        m.status === "TEAMS_PUBLISHED"),
  );
  const futureCancelled = matches.filter(
    (m) => new Date(m.dateIso).getTime() > now && m.status === "CANCELLED",
  );

  async function run(kind: "cancel" | "restore" | "delete") {
    setBusy(kind);
    try {
      if (kind === "cancel") {
        const res = await bulkCancelMatches({
          matchIds: futureLive.map((m) => m.id),
          announce: false,
        });
        toast.success(`${res.cancelled} matches cancelled (silently).`);
      } else if (kind === "restore") {
        const res = await bulkRestoreMatches({
          matchIds: futureCancelled.map((m) => m.id),
        });
        toast.success(`${res.restored} matches restored.`);
      } else {
        const res = await deleteBlockBooking(blockId);
        toast.success(
          `Block deleted — ${res.deletedMatches} empty matches removed, ${res.detachedMatches} kept (history).`,
        );
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  if (confirming) {
    const label =
      confirming === "cancel"
        ? `Cancel ${futureLive.length} future matches? No group announcement will be sent.`
        : confirming === "restore"
          ? `Restore ${futureCancelled.length} cancelled future matches?`
          : "Delete this block? Played matches and matches with data are kept (only detached); empty future matches are removed. No group announcement.";
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-600 max-w-xs">{label}</span>
        <button
          onClick={() => run(confirming)}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Confirm
        </button>
        <button
          onClick={() => setConfirming(null)}
          disabled={busy !== null}
          className="px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-medium"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 shrink-0 flex-wrap">
      {futureLive.length > 0 && (
        <button
          onClick={() => setConfirming("cancel")}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
        >
          <XCircle className="w-3.5 h-3.5" />
          Cancel remaining
        </button>
      )}
      {futureCancelled.length > 0 && (
        <button
          onClick={() => setConfirming("restore")}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium"
        >
          <Undo2 className="w-3.5 h-3.5" />
          Restore cancelled
        </button>
      )}
      <button
        onClick={() => setConfirming("delete")}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-red-600 hover:bg-red-50 text-sm font-medium"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete block
      </button>
    </div>
  );
}
