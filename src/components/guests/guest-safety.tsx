"use client";

/**
 * The guest card's organiser controls (player pool, slice L7): stop
 * offering this club's games to him (silent: he is never told), and report
 * a problem to the MatchTime team only. Organisers only: the card is shown
 * to them alone, and each action checks the role again.
 */
import { useState, useTransition } from "react";
import { poolSafetyCopy } from "@/lib/i18n/pool-safety";
import { reportGuestAction, setGuestBlockAction } from "@/app/actions/pool-safety";
import { ReportForm } from "@/components/pool/report-form";

export function GuestSafety(props: { orgId: string; userId: string; blocked: boolean; lang: string | null | undefined; matchId?: string }) {
  const c = poolSafetyCopy(props.lang);
  const [blocked, setBlocked] = useState(props.blocked);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      setFailed(false);
      try {
        const r = await setGuestBlockAction(props.orgId, props.userId, !blocked);
        if (r.ok) setBlocked(!blocked);
        else setFailed(true);
      } catch {
        setFailed(true);
      }
    });
  return (
    <div className="space-y-3 border-t border-slate-100 pt-3" data-testid="guest-safety">
      <div className="space-y-1">
        {blocked && (
          <p className="text-sm font-medium text-slate-700" data-testid="guest-blocked">
            {c.card_blocked}
          </p>
        )}
        <button
          type="button"
          data-testid="guest-block"
          data-blocked={blocked ? "yes" : "no"}
          disabled={pending}
          onClick={toggle}
          className="h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {blocked ? c.card_unblock : c.card_block}
        </button>
        <p className="text-xs text-slate-500">{c.card_block_hint}</p>
        {failed && (
          <p role="alert" className="text-sm text-red-700">
            {c.failed}
          </p>
        )}
      </div>
      <ReportForm lang={props.lang} side="club" testId="guest-report" send={(text) => reportGuestAction(props.orgId, props.userId, text, props.matchId ?? null)} />
    </div>
  );
}
