"use client";

/**
 * Share a server-rendered card (a badge, the season Wrapped card) as an
 * IMAGE. On a phone it opens the share sheet with the PNG attached, so
 * WhatsApp is one tap away; elsewhere it downloads the PNG and says how
 * to send it. Closing the share sheet is silent. The decisions live in
 * `shareImage` (src/lib/share-image.ts), which is unit tested.
 *
 * The fetch starts on pointerdown and the click reuses it, so the
 * share call follows the tap as closely as possible (Safari refuses a
 * share whose tap activation has lapsed; that case downloads instead).
 */

import { useEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { browserShareDeps, shareImage } from "@/lib/share-image";

export function ShareImageButton({
  url,
  filename,
  text,
  savedText,
  failedText,
  ariaLabel,
  label,
  className,
}: {
  url: string;
  filename: string;
  text: string;
  savedText: string;
  failedText: string;
  ariaLabel: string;
  /** Visible text next to the icon; icon only when omitted. */
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<Promise<Blob> | null>(null);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const deps = browserShareDeps();
  const prefetch = () => {
    if (!pending.current) {
      pending.current = deps.fetchImage(url);
      // A failed prefetch is retried by the click, not surfaced here.
      pending.current.catch(() => {
        pending.current = null;
      });
    }
    return pending.current;
  };

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await shareImage(
        { url, filename, text },
        { ...deps, fetchImage: () => prefetch() },
      );
      if (outcome === "downloaded") setNotice(savedText);
      if (outcome === "failed") setNotice(failedText);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onPointerDown={() => void prefetch()}
        onClick={onClick}
        disabled={busy}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={
          className ??
          "inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 disabled:opacity-60"
        }
      >
        <Share2 className="w-4 h-4" />
        {label}
      </button>
      {notice && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-6 z-50 mx-auto w-fit max-w-[90vw] rounded-full bg-slate-900/90 px-4 py-2 text-sm text-white shadow-lg"
        >
          {notice}
        </div>
      )}
    </>
  );
}
