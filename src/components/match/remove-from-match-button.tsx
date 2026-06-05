"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
import { removePlayerFromMatch } from "@/app/actions/players";

/** Admin-only: remove a player from a match squad. Confirms first. */
export function RemoveFromMatchButton({
  matchId,
  userId,
  name,
}: {
  matchId: string;
  userId: string;
  name: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirm(`Remove ${name ?? "this player"} from the squad?`)) return;
    setBusy(true);
    try {
      await removePlayerFromMatch(matchId, userId);
      toast.success(`Removed ${name ?? "player"}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={remove}
      disabled={busy}
      title="Remove from squad"
      className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
    >
      <X className="w-4 h-4" />
    </button>
  );
}
