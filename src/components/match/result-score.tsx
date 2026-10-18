import Link from "next/link";
import { Plus } from "lucide-react";
import { scorePanelHref } from "@/lib/score-entry";

/**
 * The right-hand side of a result row (dashboard "Recent results" and
 * the Past tab on /matches): the score when there is one, and for an
 * admin an "Add score" link when there is not (FNF, 2026-10-18: a
 * COMPLETED match without a score showed nothing, so nothing said a
 * result was missing). The link opens the match page with its score
 * panel already open (Kemal, 2026-10-18), not the teams page, which
 * shows no match date.
 *
 * The row itself is a stretched link (its title link covers the row),
 * so this link sits above it with `relative z-10` instead of being
 * nested inside another <a>.
 */
export function ResultScore({
  matchId,
  redScore,
  yellowScore,
  isAdmin,
  addLabel,
  large = false,
}: {
  matchId: string;
  redScore: number | null;
  yellowScore: number | null;
  isAdmin: boolean;
  addLabel: string;
  large?: boolean;
}) {
  if (redScore !== null && yellowScore !== null) {
    return (
      <div className={`flex items-center font-mono font-bold shrink-0 ${large ? "gap-3 text-lg" : "gap-2"}`}>
        <span className="text-red-500">{redScore}</span>
        <span className={`text-slate-300 ${large ? "text-base" : ""}`}>-</span>
        <span className="text-amber-500">{yellowScore}</span>
      </div>
    );
  }
  if (!isAdmin) return null;
  return (
    <Link
      href={scorePanelHref(matchId)}
      data-testid="result-add-score"
      className="relative z-10 shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 text-sm font-medium"
    >
      <Plus className="w-3.5 h-3.5" />
      {addLabel}
    </Link>
  );
}
