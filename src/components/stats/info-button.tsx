"use client";

/**
 * Small "i" button that opens a mobile-friendly bottom-sheet explaining
 * a stat or a section. Tap the button → sheet slides up from the bottom
 * (the comfy thumb zone on a phone) with a title + plain-English
 * explanation. Tap the backdrop, the close button or Escape to dismiss.
 *
 * Used next to any stat header that might confuse a player (chemistry,
 * nemesis, vs-squad, ...) and, since F1 (2026-10-05), next to every
 * section, badge and field on the organiser pages ("owners need info").
 *
 * Safe anywhere in the tree:
 *   - the sheet is portalled to <body>, so it can sit inside a <p>, a
 *     <label> or a heading without nesting a <div> where HTML forbids it;
 *   - the trigger and the sheet stop the click from reaching an ancestor
 *     (a tile that is a <Link>, a <label> that would focus its input), so
 *     opening or reading the popup never navigates or toggles anything.
 *
 * `label` and `closeLabel` let a caller pass the club's language; both
 * default to the English the existing specs look for ("What is X?",
 * "Close"). `testId` names the trigger `info-<testId>` for the e2e specs.
 */

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Info, X } from "lucide-react";

export function InfoButton({
  title,
  children,
  label,
  closeLabel = "Close",
  testId,
}: {
  title: string;
  children: React.ReactNode;
  /** The trigger's accessible name. Defaults to `What is ${title}?`. */
  label?: string;
  closeLabel?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  // Lock body scroll and listen for Escape while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const stop = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const sheet = (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      // React events bubble through a portal to the React parent, so a
      // click in here would otherwise reach a surrounding <Link>.
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
      }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId ? `info-sheet-${testId}` : "info-sheet"}
        className="relative w-full max-w-md bg-white rounded-t-3xl p-6 pb-8 shadow-2xl animate-[slideUp_0.2s_ease-out] text-left normal-case tracking-normal font-normal"
        onClick={(e) => e.stopPropagation()}
        style={{ animationName: "slideUp" }}
      >
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-slate-200" />
        <div className="flex items-start justify-between mt-2">
          <h3 className="text-lg font-bold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              setOpen(false);
            }}
            aria-label={closeLabel}
            className="text-slate-400 hover:text-slate-600 -mr-1 -mt-1 p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="mt-3 text-sm leading-relaxed text-slate-600 space-y-2">{children}</div>
      </div>
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          setOpen(true);
        }}
        aria-label={label ?? `What is ${title}?`}
        aria-haspopup="dialog"
        data-testid={testId ? `info-${testId}` : undefined}
        className="inline-flex shrink-0 items-center justify-center w-5 h-5 rounded-full text-slate-400 hover:text-slate-600 active:scale-95 align-middle"
      >
        <Info className="w-4 h-4" />
      </button>
      {open && typeof document !== "undefined" && createPortal(sheet, document.body)}
    </>
  );
}
