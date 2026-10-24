"use client";

/**
 * Join / No thanks on one club invitation (pool L8). The answer is a
 * button, never the page load (WhatsApp fetches links for previews).
 */
import { useState, useTransition } from "react";
import { inviteCopy } from "@/lib/i18n/pool-invite";
import { answerMyInvitation } from "@/app/actions/club-invite";
import type { PlayerAnswerResult } from "@/lib/pool/club-invitation";

export function InvitationAnswer(props: { invitationId: string; state: "waiting-him" | "waiting-club"; language: string }) {
  const c = inviteCopy(props.language);
  const [result, setResult] = useState<PlayerAnswerResult | "error" | null>(props.state === "waiting-club" ? "waiting-club" : null);
  const [pending, start] = useTransition();

  const answer = (a: "join" | "no") =>
    start(async () => {
      try {
        setResult(await answerMyInvitation(props.invitationId, a));
      } catch {
        setResult("error");
      }
    });

  if (result && result !== "error") {
    const text =
      result === "waiting-club" ? c.inv_waiting_club : result === "link-sent" ? c.inv_link_sent : result === "declined" ? c.inv_declined : result === "member" ? c.inv_member : c.inv_try_again;
    return (
      <p role="status" data-testid="my-invitation-result" data-result={result} className="text-sm font-medium text-slate-800">
        {text}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="my-invitation-join"
          disabled={pending}
          onClick={() => answer("join")}
          className="h-11 px-5 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {c.inv_join}
        </button>
        <button
          type="button"
          data-testid="my-invitation-no"
          disabled={pending}
          onClick={() => answer("no")}
          className="h-11 px-5 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {c.inv_no}
        </button>
      </div>
      {result === "error" && (
        <p role="alert" className="text-sm text-red-700">
          {c.inv_try_again}
        </p>
      )}
    </div>
  );
}
