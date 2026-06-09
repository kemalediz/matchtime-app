"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUp } from "lucide-react";
import { moveUpFromBench } from "@/app/actions/players";

/** Admin-only: promote a bench player into the playing squad (squad
 *  management — does not assign a team). */
export function MoveUpFromBenchButton({
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

  async function moveUp() {
    setBusy(true);
    try {
      await moveUpFromBench(matchId, userId);
      toast.success(`${name ?? "Player"} moved up to the squad`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to move up");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={moveUp}
      disabled={busy}
      title="Move up to squad"
      className="shrink-0 inline-flex items-center gap-1 px-2 h-6 rounded-md text-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-[11px] font-semibold disabled:opacity-50"
    >
      <ArrowUp className="w-3.5 h-3.5" /> Move up
    </button>
  );
}
