"use client";

/**
 * "Did your guests turn up?" on the match page (player pool, slice L7).
 * Organisers only, from kickoff: each guest who held a place, first name
 * and last initial, his turn-up record, and Turned up / Didn't turn up
 * until 24 hours after kickoff. A guest nobody marks counts as played. Then
 * the results are final. The server checks the role and the window again.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { poolSafetyCopy } from "@/lib/i18n/pool-safety";
import { t } from "@/lib/i18n/t";
import { markGuestNoShowAction } from "@/app/actions/pool-safety";
import { turnUpText } from "@/components/guests/guest-text";
import type { GuestResultRow } from "@/lib/pool/no-shows";

export function GuestResultsPanel(props: { matchId: string; lang: string | null | undefined; until: string; final: boolean; rows: GuestResultRow[] }) {
  const c = poolSafetyCopy(props.lang);
  const s = t(props.lang);
  const router = useRouter();
  const [results, setResults] = useState<Record<string, string>>(Object.fromEntries(props.rows.map((r) => [r.userId, r.result])));
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const mark = (userId: string, noShow: boolean) =>
    start(async () => {
      setFailed(false);
      try {
        const r = await markGuestNoShowAction(props.matchId, userId, noShow);
        if (r.ok) {
          setResults((prev) => ({ ...prev, [userId]: noShow ? "no-show" : "played" }));
          router.refresh();
        } else setFailed(true);
      } catch {
        setFailed(true);
      }
    });
  const btn = (on: boolean) =>
    `h-9 px-3 rounded-lg border text-sm disabled:opacity-50 ${on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`;
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4" data-testid="guest-results-panel">
      <h3 className="text-sm font-semibold text-slate-800">{c.mark_title}</h3>
      <p className="mt-1 text-xs text-slate-500" data-testid="guest-results-hint">
        {props.final ? c.mark_final : c.mark_hint({ until: props.until })}
      </p>
      <ul className="mt-3 space-y-3">
        {props.rows.map((g) => {
          const noShow = results[g.userId] === "no-show";
          return (
            <li key={g.userId} data-testid="guest-result-row" data-result={noShow ? "no-show" : "played"} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-slate-800">
                {g.name ?? s.gst_nameless}
                <span className="block text-xs text-slate-500">{turnUpText(s, g.record)}</span>
              </span>
              {g.changeable ? (
                <span className="flex gap-2" role="group" aria-label={g.name ?? s.gst_nameless}>
                  <button type="button" data-testid="guest-turned-up" aria-pressed={!noShow} disabled={pending} onClick={() => noShow && mark(g.userId, false)} className={btn(!noShow)}>
                    {c.mark_turned_up}
                  </button>
                  <button type="button" data-testid="guest-no-show" aria-pressed={noShow} disabled={pending} onClick={() => !noShow && mark(g.userId, true)} className={btn(noShow)}>
                    {c.mark_no_show}
                  </button>
                </span>
              ) : (
                <span className="text-sm font-medium text-slate-700" data-testid="guest-result-final">
                  {noShow ? c.mark_no_show : c.mark_turned_up}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {c.mark_failed}
        </p>
      )}
    </section>
  );
}
