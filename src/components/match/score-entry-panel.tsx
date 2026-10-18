"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";
import { updateMatchScore } from "@/app/actions/matches";
import { t } from "@/lib/i18n/t";
import { validateScorePair, SCORE_PANEL_PARAM } from "@/lib/score-entry";

/**
 * Enter or edit a played match's score on the match page itself (Kemal,
 * 2026-10-18). "Enter score" / "Edit score" in the result bar used to send
 * the admin to the teams page, which does not show the match date. Now the
 * button opens this panel in place, inside the result bar: the two boxes
 * labelled with the club's team labels, Save and Cancel. Save calls
 * `updateMatchScore` unchanged and refreshes the page, so the bar shows the
 * new score and "Edit score".
 *
 * An inline panel rather than a modal: at 390px it is the full width of the
 * bar, the result it changes stays in view above it, and there is no
 * overlay to trap focus in. `initialOpen` comes from `?score=1`, which the
 * result lists' "Add score" links carry (`scorePanelHref`).
 */
export function ScoreEntryPanel({
  matchId,
  lang,
  action,
  redLabel,
  yellowLabel,
  redScore,
  yellowScore,
  initialOpen = false,
}: {
  matchId: string;
  lang: string;
  action: "enter" | "edit";
  redLabel: string;
  yellowLabel: string;
  redScore: number | null;
  yellowScore: number | null;
  initialOpen?: boolean;
}) {
  const s = t(lang);
  const router = useRouter();
  const ids = useId();
  const prefill = (n: number | null) => (n === null ? "" : String(n));

  const [open, setOpen] = useState(initialOpen);
  const [red, setRed] = useState(prefill(redScore));
  const [yellow, setYellow] = useState(prefill(yellowScore));
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<"red" | "yellow" | null>(null);
  const [busy, setBusy] = useState(false);

  const redRef = useRef<HTMLInputElement>(null);
  const yellowRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // Opened from "Add score" on a result list: take `?score=1` off the
  // address so a reload does not open it again. Through the router, not
  // `history.replaceState`: the router's own URL would otherwise bring the
  // query back on the next `router.refresh()`. The panel stays open, since
  // the same component carries its state across the replace.
  useEffect(() => {
    if (!initialOpen) return;
    const url = new URL(window.location.href);
    if (url.searchParams.has(SCORE_PANEL_PARAM)) {
      url.searchParams.delete(SCORE_PANEL_PARAM);
      router.replace(url.pathname + url.search + url.hash, { scroll: false });
    }
  }, [initialOpen, router]);

  useEffect(() => {
    if (open) {
      redRef.current?.focus();
      redRef.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  function openPanel() {
    // Prefill from the score the page shows now (it changes after a save).
    setRed(prefill(redScore));
    setYellow(prefill(yellowScore));
    setError(null);
    setInvalid(null);
    setOpen(true);
  }

  function close() {
    if (busy) return;
    restoreFocus.current = true;
    setOpen(false);
    setError(null);
    setInvalid(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const v = validateScorePair(red, yellow);
    if (!v.ok) {
      setInvalid(v.field);
      setError(s.score_panel_err_invalid);
      (v.field === "red" ? redRef : yellowRef).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid(null);
    try {
      const res = await updateMatchScore(matchId, { redScore: v.redScore, yellowScore: v.yellowScore });
      // The score always lands. When the Elo could not be recalculated for
      // it, say so (in the club's language) and leave it up long enough to
      // read, as the teams page does.
      if (res?.eloNote) toast.warning(res.eloNote, { duration: 20_000 });
      else toast.success(s.score_panel_saved);
      restoreFocus.current = true;
      setOpen(false);
      router.refresh();
    } catch (err) {
      // A production build replaces a server action's message with a
      // generic one, which is no use to an admin: say it plainly instead.
      const msg = err instanceof Error ? err.message : "";
      setError(msg && !/Server Components render|digest/i.test(msg) ? msg : s.score_panel_err_failed);
    } finally {
      setBusy(false);
    }
  }

  const label = action === "edit" ? s.score_entry_edit : s.score_entry_enter;
  const triggerClass =
    action === "enter"
      ? "inline-flex items-center justify-center gap-1 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
      : "inline-flex items-center justify-center gap-1 px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium";

  if (!open) {
    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={openPanel}
        data-testid="score-entry-link"
        aria-expanded={false}
        aria-controls={`${ids}-panel`}
        className={triggerClass}
      >
        {label}
        <ChevronRight className="w-4 h-4" aria-hidden="true" />
      </button>
    );
  }

  const inputClass = (bad: boolean) =>
    `w-20 h-12 text-center text-2xl font-bold tabular-nums rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
      bad ? "border-red-400" : "border-slate-300"
    }`;

  return (
    <form
      id={`${ids}-panel`}
      role="group"
      aria-labelledby={`${ids}-title`}
      data-testid="score-panel"
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
      noValidate
      className="w-full basis-full sm:order-first rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5 text-left space-y-4"
    >
      <h3 id={`${ids}-title`} className="text-sm font-semibold text-slate-800 text-center">
        {s.score_panel_title}
      </h3>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3 sm:gap-5 max-w-sm mx-auto">
        <label htmlFor={`${ids}-red`} className="flex flex-col items-center gap-2 min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700 max-w-full">
            <span className="h-3 w-3 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
            <span className="truncate">{redLabel}</span>
          </span>
          <input
            ref={redRef}
            id={`${ids}-red`}
            data-testid="score-panel-red"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label={s.score_panel_input_label({ team: redLabel })}
            aria-invalid={invalid === "red"}
            aria-describedby={error ? `${ids}-error` : undefined}
            value={red}
            onChange={(e) => setRed(e.target.value)}
            disabled={busy}
            className={inputClass(invalid === "red")}
          />
        </label>
        <span className="pb-3 text-2xl font-bold text-slate-300" aria-hidden="true">
          -
        </span>
        <label htmlFor={`${ids}-yellow`} className="flex flex-col items-center gap-2 min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700 max-w-full">
            <span className="h-3 w-3 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
            <span className="truncate">{yellowLabel}</span>
          </span>
          <input
            ref={yellowRef}
            id={`${ids}-yellow`}
            data-testid="score-panel-yellow"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label={s.score_panel_input_label({ team: yellowLabel })}
            aria-invalid={invalid === "yellow"}
            aria-describedby={error ? `${ids}-error` : undefined}
            value={yellow}
            onChange={(e) => setYellow(e.target.value)}
            disabled={busy}
            className={inputClass(invalid === "yellow")}
          />
        </label>
      </div>
      {error && (
        <p id={`${ids}-error`} role="alert" data-testid="score-panel-error" className="text-sm text-red-600 text-center">
          {error}
        </p>
      )}
      <div className="flex flex-col-reverse sm:flex-row sm:justify-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={close}
          disabled={busy}
          data-testid="score-panel-cancel"
          className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium disabled:opacity-50"
        >
          {s.score_panel_cancel}
        </button>
        <button
          type="submit"
          disabled={busy}
          data-testid="score-panel-save"
          className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50"
        >
          {busy ? s.score_panel_saving : s.score_panel_save}
        </button>
      </div>
    </form>
  );
}
