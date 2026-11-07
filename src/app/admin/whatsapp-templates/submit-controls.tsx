"use client";

/**
 * "Submit to Meta" on the owner's WhatsApp templates page, with a
 * confirmation step on the page (not a browser dialog): the first press
 * says what will be sent and asks again; only "Yes, submit to Meta" runs
 * the server action. The result is shown per template. English only.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitCloudTemplatesAction } from "@/app/actions/cloud-templates";
import { SyncResultList, type SubmitOutcome } from "./template-sync-view";

const BTN = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function SubmitTemplatesControls({ newCount, changedCount }: { newCount: number; changedCount: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SubmitOutcome | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      try {
        setResult(await submitCloudTemplatesAction());
      } catch {
        setResult({ state: "error", message: "the request did not finish. Reload and check the list before trying again." });
      }
      setConfirming(false);
      router.refresh();
    });

  return (
    <div className="space-y-4" data-testid="wt-submit">
      {!confirming && (
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
          disabled={pending}
          data-testid="wt-submit-start"
          className={`${BTN} bg-slate-900 text-white hover:bg-slate-800 focus:ring-slate-500`}
        >
          Submit to Meta
        </button>
      )}
      {confirming && (
        <div role="group" aria-labelledby="wt-confirm-title" data-testid="wt-confirm" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p id="wt-confirm-title" className="text-sm font-semibold text-amber-900">
            Submit {plural(newCount, "new template", "new templates")} and edit {plural(changedCount, "changed one", "changed ones")} at Meta?
          </p>
          <p className="text-sm text-amber-900">
            Meta reviews each submission. A template it rejects or moves to marketing stays that way until it is edited. A pending template is not edited,
            and nothing is ever deleted.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              data-testid="wt-confirm-yes"
              className={`${BTN} bg-amber-600 text-white hover:bg-amber-700 focus:ring-amber-500`}
            >
              {pending ? "Submitting..." : "Yes, submit to Meta"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              data-testid="wt-confirm-cancel"
              className={`${BTN} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-400`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {result && (
        <div role="status" data-testid="wt-results" className="rounded-xl border border-slate-200 bg-white p-4">
          <h4 className="mb-2 text-sm font-semibold text-slate-900">What happened</h4>
          <SyncResultList result={result} />
        </div>
      )}
    </div>
  );
}
