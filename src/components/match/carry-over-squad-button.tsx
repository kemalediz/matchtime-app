"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Repeat } from "lucide-react";
import { carryOverLastSquad } from "@/app/actions/matches";
import { t } from "@/lib/i18n/t";

/**
 * Admin only, rolling-squad clubs only (2026-09-30): copies the last
 * played match's squad onto this empty match. Words from the club's
 * language table; `sourceDateLabel` is already formatted in it.
 */
export function CarryOverSquadButton({
  matchId,
  lang,
  sourceDateLabel,
}: {
  matchId: string;
  lang: string;
  sourceDateLabel: string;
}) {
  const s = t(lang);
  const labels = {
    button: s.carry_over_button,
    hint: s.carry_over_hint({ dateLabel: sourceDateLabel }),
    done: (count: number) => s.carry_over_done({ count }),
    nothing: s.carry_over_nothing,
  };
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function carry() {
    setBusy(true);
    try {
      const { carried } = await carryOverLastSquad(matchId);
      if (carried > 0) toast.success(labels.done(carried));
      else toast(labels.nothing);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : labels.nothing);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={carry}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 h-10 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium disabled:opacity-50"
      >
        <Repeat className="w-4 h-4" />
        {labels.button}
      </button>
      <p className="text-xs text-slate-500">{labels.hint}</p>
    </div>
  );
}
