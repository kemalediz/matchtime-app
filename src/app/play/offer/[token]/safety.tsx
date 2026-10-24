"use client";

/**
 * The offer page's safety line (player pool, slice L7), for the offer's
 * holder only: "Don't offer me games from <club>" (the club is not told)
 * and "Report a problem" (the MatchTime team only). The server proves the
 * holder again.
 */
import { useState, useTransition } from "react";
import { poolSafetyCopy } from "@/lib/i18n/pool-safety";
import { ReportForm } from "@/components/pool/report-form";
import { blockOfferClubAction, reportOfferClubAction } from "../actions";

export function OfferSafety(props: { token: string; language: string; club: string; blocked: boolean }) {
  const c = poolSafetyCopy(props.language);
  const [blocked, setBlocked] = useState(props.blocked);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const block = () =>
    start(async () => {
      setFailed(false);
      const r = await blockOfferClubAction(props.token);
      if (r.ok) setBlocked(true);
      else setFailed(true);
    });
  return (
    <div className="mt-8 space-y-3 border-t border-slate-200 pt-5" data-testid="pool-offer-safety">
      {blocked ? (
        <p role="status" className="text-sm text-slate-700" data-testid="pool-offer-blocked">
          {c.offer_blocked({ club: props.club })}
        </p>
      ) : (
        <button
          type="button"
          data-testid="pool-offer-block"
          disabled={pending}
          onClick={block}
          className="h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {c.offer_block({ club: props.club })}
        </button>
      )}
      {failed && (
        <p role="alert" className="text-sm text-red-700">
          {c.failed}
        </p>
      )}
      <ReportForm lang={props.language} side="player" testId="pool-offer-report" send={(text) => reportOfferClubAction(props.token, text)} />
    </div>
  );
}
