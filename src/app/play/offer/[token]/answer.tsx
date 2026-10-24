"use client";

/**
 * The offer page's buttons (local player pool L5a): Yes / No thanks while
 * the offer is open, "I can't make it any more" once he has a place. Each
 * answer changes HIS record, so until this phone has proved it is him
 * (review of #400, M2) the page shows one field instead (the last 4 digits
 * of the WhatsApp number the offer came to) and "Show my offer"; his
 * offer's state and its answers come after. The server decides again.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { poolCopy } from "@/lib/i18n/pool-offer";
import type { OfferPageState } from "@/lib/pool/accept-rules";
import { acceptPoolOfferAction, declinePoolOfferAction, provePoolOfferAction, pullOutPoolOfferAction } from "../actions";

type Answer = { state: OfferPageState | null; verify?: "needed" | "wrong" | "locked" };

export function PoolOfferAnswer(props: { token: string; language: string; state: OfferPageState; verified: boolean }) {
  const c = poolCopy(props.language);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  const [digits, setDigits] = useState("");
  const [verify, setVerify] = useState<Answer["verify"] | null>(null);
  const needsDigits = !props.verified;
  const ready = !needsDigits || /^\d{4}$/.test(digits);
  const answerable = props.state === "open" || props.state === "in" || props.state === "bench";

  const go = (fn: (token: string, digits: string | null) => Promise<Answer>) =>
    start(async () => {
      setFailed(false);
      setVerify(null);
      try {
        const r = await fn(props.token, needsDigits ? digits : null);
        if (r.verify) {
          setVerify(r.verify);
          return;
        }
        if (r.state === "open" && props.state === "open") setFailed(true);
        router.refresh();
      } catch {
        setFailed(true);
      }
    });

  // Unproved: one field and "Show my offer" (the answers come after).
  if (needsDigits) {
    return (
      <div className="mt-6 space-y-3">
        {verify !== "locked" && (
          <>
            <label className="flex flex-col gap-1 text-sm text-slate-700">
              {c.page_verify_label}
              <input
                data-testid="pool-offer-digits"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={digits}
                onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="h-11 w-28 rounded-lg border border-slate-300 px-3 text-lg tracking-widest"
              />
            </label>
            <button
              type="button"
              data-testid="pool-offer-confirm"
              disabled={pending || !ready}
              onClick={() => go(provePoolOfferAction)}
              className="h-11 px-4 rounded-xl bg-slate-900 text-white text-sm font-medium disabled:opacity-50"
            >
              {c.page_confirm}
            </button>
          </>
        )}
        {verify === "wrong" && (
          <p className="text-sm text-red-700" role="alert" data-testid="pool-offer-verify-wrong">
            {c.page_verify_wrong}
          </p>
        )}
        {verify === "locked" && (
          <p className="text-sm text-red-700" role="alert" data-testid="pool-offer-verify-locked">
            {c.page_verify_locked}
          </p>
        )}
      </div>
    );
  }
  if (!answerable) return null;
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
