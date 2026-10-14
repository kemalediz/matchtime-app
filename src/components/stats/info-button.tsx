"use client";

/**
 * Small "i" button that opens a mobile-friendly popup explaining a stat,
 * a section or a setting. Tap the button and a panel slides up from the
 * bottom (the comfy thumb zone on a phone) with a title and a
 * plain-English explanation. Tap outside it, the close button or Escape
 * to dismiss.
 *
 * Used next to any stat header that might confuse a player (chemistry,
 * nemesis, vs-squad, ...), next to every section, badge and field on the
 * organiser pages ("owners need info", F1, 2026-10-05), and next to every
 * setting on /admin/settings (`SettingInfo`, 2026-10-15).
 *
 * Accessible (2026-10-15):
 *   - a modal dialog named by its heading (`aria-labelledby`);
 *   - opening it moves the focus to its close button, Tab and Shift+Tab
 *     stay inside it, and closing it (Escape, the close button, a tap
 *     outside) puts the focus back on the "i" that opened it;
 *   - long text scrolls inside the panel, which never runs off a phone
 *     screen: a 16px gutter on every side;
 *   - dark: follows the `.dark` class the app's theme uses and the
 *     viewer's own dark-mode preference.
 *
 * Safe anywhere in the tree:
 *   - the panel is portalled to <body>, so it can sit inside a <p>, a
 *     <label> or a heading without nesting a <div> where HTML forbids it;
 *   - the trigger and the panel stop the click from reaching an ancestor
 *     (a tile that is a <Link>, a <label> that would focus its input), so
 *     opening or reading the popup never navigates or toggles anything.
 *
 * `label` and `closeLabel` let a caller pass the club's language; both
 * default to the English the existing specs look for ("What is X?",
 * "Close"). `testId` names the trigger `info-<testId>` for the e2e specs.
 */

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, X } from "lucide-react";

/** Everything in the panel that can take the focus, for the Tab trap. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  // While open: lock the page's scroll, focus the close button, keep Tab
  // inside the panel, close on Escape. On close: focus back on the "i".
  useEffect(() => {
    if (!open) return;
    const opener = trigger.current;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [open]);

  const stop = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const sheet = (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      data-testid="info-backdrop"
      // React events bubble through a portal to the React parent, so a
      // click in here would otherwise reach a surrounding <Link>.
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
      }}
    >
      <div className="absolute inset-0 bg-black/40 info-dark:bg-black/60" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid={testId ? `info-sheet-${testId}` : "info-sheet"}
        className="info-sheet relative flex w-full max-w-md max-h-[calc(100dvh-2rem)] flex-col rounded-3xl border border-transparent bg-white p-6 pb-7 shadow-2xl text-left normal-case tracking-normal font-normal info-dark:border-slate-700 info-dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3">
          <h3 id={headingId} className="text-lg font-bold text-slate-900 info-dark:text-slate-50">
            {title}
          </h3>
          <button
            ref={closeButton}
            type="button"
            onClick={(e) => {
              stop(e);
              setOpen(false);
            }}
            aria-label={closeLabel}
            className="-mr-1 -mt-1 rounded-full p-1 text-slate-400 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 info-dark:text-slate-400 info-dark:hover:text-slate-200"
          >
            <X aria-hidden="true" className="w-5 h-5" />
          </button>
        </div>
        <div className="mt-3 min-h-0 overflow-y-auto overscroll-contain text-sm leading-relaxed text-slate-600 space-y-2 [overflow-wrap:anywhere] info-dark:text-slate-300">
          {children}
        </div>
      </div>
      <style>{`
        @keyframes infoSheetUp {
          from { transform: translateY(24px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .info-sheet { animation: infoSheetUp 0.18s ease-out; }
        @media (prefers-reduced-motion: reduce) { .info-sheet { animation: none; } }
      `}</style>
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={(e) => {
          stop(e);
          setOpen(true);
        }}
        aria-label={label ?? `What is ${title}?`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId ? `info-${testId}` : undefined}
        className="inline-flex shrink-0 items-center justify-center w-5 h-5 rounded-full text-slate-400 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 active:scale-95 align-middle"
      >
        <Info aria-hidden="true" className="w-4 h-4" />
      </button>
      {open && typeof document !== "undefined" && createPortal(sheet, document.body)}
    </>
  );
}
