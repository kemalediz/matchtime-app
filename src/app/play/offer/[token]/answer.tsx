"use client";

/**
 * The offer page's buttons (local player pool L5a): Yes / No thanks while
 * the offer is open, "I can't make it any more" once he has a place. The
 * server decides again; the page then shows what it says.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { poolCopy } from "@/lib/i18n/pool-offer";
import type { OfferPageState } from "@/lib/pool/accept-rules";
import { acceptPoolOfferAction, declinePoolOfferAction, pullOutPoolOfferAction } from "../actions";

export function PoolOfferAnswer(props: { token: string; language: string; state: OfferPageState }) {
  const c = poolCopy(props.language);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);

  const go = (fn: (token: string) => Promise<{ state: OfferPageState }>) =>
    start(async () => {
      setFailed(false);
      try {
        const r = await fn(props.token);
        if (r.state === "open" && props.state === "open") setFailed(true);
        router.refresh();
      } catch {
        setFailed(true);
      }
    });

  return (
    <div className="mt-6 space-y-3">
      {props.state === "open" && (
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            data-testid="pool-offer-yes"
            disabled={pending}
            onClick={() => go(acceptPoolOfferAction)}
            className="h-12 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
          >
            {c.page_yes}
          </button>
          <button
            type="button"
            data-testid="pool-offer-no"
            disabled={pending}
            onClick={() => go(declinePoolOfferAction)}
            className="h-12 px-5 rounded-xl border border-slate-300 text-slate-800 hover:bg-slate-100 disabled:opacity-50"
          >
            {c.page_no}
          </button>
        </div>
      )}
      {(props.state === "in" || props.state === "bench") && (
        <button
          type="button"
          data-testid="pool-offer-pull-out"
          disabled={pending}
          onClick={() => go(pullOutPoolOfferAction)}
          className="h-11 px-4 rounded-xl border border-slate-300 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {c.page_pull_out}
        </button>
      )}
      {failed && (
        <p className="text-sm text-red-700" role="alert" data-testid="pool-offer-error">
          {c.page_try_again}
        </p>
      )}
    </div>
  );
}
