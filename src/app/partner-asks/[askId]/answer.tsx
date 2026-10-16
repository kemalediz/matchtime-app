"use client";

/** Yes or no to a partner club's ask (slice S2). The server checks who is
 *  answering and that the ask is still waiting; this only shows the result. */
import { useState, useTransition } from "react";
import { t } from "@/lib/i18n/t";
import { answerPartnerAskAction } from "@/app/actions/partner-asks";

export function PartnerAskAnswer(props: { askId: string; language: string }) {
  const s = t(props.language);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const answer = (a: "yes" | "no") =>
    start(async () => {
      try {
        const r = await answerPartnerAskAction(props.askId, a);
        setResult(r.ok ? (a === "yes" ? s.xask_page_posted : s.xask_page_declined) : s.xask_page_closed);
      } catch {
        setResult(s.xask_page_closed);
      }
    });

  if (result) {
    return (
      <p className="text-sm text-slate-700" data-testid="partner-ask-result">
        {result}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="button"
        data-testid="partner-ask-approve"
        disabled={pending}
        onClick={() => answer("yes")}
        className="h-11 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
      >
        {s.xask_page_approve}
      </button>
      <button
        type="button"
        data-testid="partner-ask-decline"
        disabled={pending}
        onClick={() => answer("no")}
        className="h-11 px-4 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium disabled:opacity-50"
      >
        {s.xask_page_decline}
      </button>
    </div>
  );
}
