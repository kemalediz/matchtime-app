"use client";

/**
 * Small "i" button that opens a mobile-friendly bottom-sheet explaining
 * a stat. Tap the button → sheet slides up from the bottom (the comfy
 * thumb zone on a phone) with a title + plain-English explanation. Tap
 * the backdrop or the close button to dismiss. Used next to any stat
 * header that might confuse a player (chemistry, nemesis, vs-squad,
 * team of the season, leaderboard movement, etc.).
 */

import { useState, useEffect } from "react";
import { Info, X } from "lucide-react";

export function InfoButton({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  // Lock body scroll while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`What is ${title}?`}
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-slate-400 hover:text-slate-600 active:scale-95"
      >
        <Info className="w-4 h-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative w-full max-w-md bg-white rounded-t-3xl p-6 pb-8 shadow-2xl animate-[slideUp_0.2s_ease-out]"
            onClick={(e) => e.stopPropagation()}
            style={{ animationName: "slideUp" }}
          >
            <div className="absolute top-3 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-slate-200" />
            <div className="flex items-start justify-between mt-2">
              <h3 className="text-lg font-bold text-slate-900">{title}</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-slate-400 hover:text-slate-600 -mr-1 -mt-1 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-3 text-sm leading-relaxed text-slate-600 space-y-2">{children}</div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
