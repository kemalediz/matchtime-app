"use client";

/**
 * "Report a problem" (player pool, slice L7): one button that opens a text
 * box and sends it to the MatchTime team only. Used by organisers (the guest
 * card) and by players (the manage page, the offer page); the caller hands
 * in the label and the send. Says nothing about who it is about.
 */
import { useId, useState, useTransition } from "react";
import { poolSafetyCopy } from "@/lib/i18n/pool-safety";
import { POOL_RELIABILITY } from "@/lib/pool/reliability-rules";

export function ReportForm(props: {
  lang: string | null | undefined;
  /** Who is NOT told: "club" (the organisers report) or "player". */
  side: "club" | "player";
  send: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  testId?: string;
}) {
  const c = poolSafetyCopy(props.lang);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sent" | "short" | "failed">("idle");
  const [pending, start] = useTransition();
  const testId = props.testId ?? "pool-report";

  if (state === "sent")
    return (
      <p role="status" data-testid={`${testId}-sent`} className="text-sm text-emerald-800">
        {c.report_sent}
      </p>
    );
  if (!open)
    return (
      <button type="button" data-testid={`${testId}-open`} onClick={() => setOpen(true)} className="h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50">
        {c.report_open}
      </button>
    );
  const send = () =>
    start(async () => {
      if (text.trim().length < POOL_RELIABILITY.reportTextMin) {
        setState("short");
        return;
      }
      try {
        const r = await props.send(text);
        setState(r.ok ? "sent" : r.reason === "too-short" ? "short" : "failed");
      } catch {
        setState("failed");
      }
    });
  return (
    <div className="space-y-2" data-testid={`${testId}-form`}>
      <label htmlFor={id} className="block text-sm text-slate-700">
        {props.side === "club" ? c.report_label_club : c.report_label_player}
      </label>
      <textarea
        id={id}
        data-testid={`${testId}-text`}
        value={text}
        maxLength={POOL_RELIABILITY.reportTextMax}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="w-full rounded-lg border border-slate-300 p-2 text-sm"
      />
      {(state === "short" || state === "failed") && (
        <p role="alert" data-testid={`${testId}-error`} className="text-sm text-red-700">
          {state === "short" ? c.report_too_short : c.report_failed}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid={`${testId}-send`} disabled={pending} onClick={send} className="h-10 px-4 rounded-lg bg-slate-900 text-sm font-medium text-white disabled:opacity-50">
          {c.report_send}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-700">
          {c.report_cancel}
        </button>
      </div>
    </div>
  );
}
