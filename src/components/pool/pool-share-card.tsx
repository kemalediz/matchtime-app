"use client";

/**
 * "BRING A FRIEND" (pool slice G1): his own /play?ref= link with a Copy
 * button, and "Share on WhatsApp", which opens WhatsApp's chat picker with
 * the ready-to-forward message. On /play/manage and in the /profile "Play
 * elsewhere too" card. Loads its own data (`loadPoolShareAction`) and shows
 * nothing without a live pool profile. No wording here (`pool-share.ts`).
 *
 * Privacy: the link and the message carry no number; the line under them
 * says whether people who open it see his name (his privacy switch).
 */
import { useEffect, useState } from "react";
import { Copy, MessageCircle, Users } from "lucide-react";
import { loadPoolShareAction } from "@/app/actions/pool-share";
import type { Lang } from "@/lib/i18n/lang";
import { poolShareCopy } from "@/lib/i18n/pool-share";
import type { PoolShareView } from "@/lib/pool/growth";

const BTN = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2";

export function PoolShareCard({ lang, refreshKey }: { lang: Lang; refreshKey?: unknown }) {
  const s = poolShareCopy(lang);
  const [view, setView] = useState<PoolShareView | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    let alive = true;
    void loadPoolShareAction()
      .then((v) => alive && setView(v))
      .catch(() => alive && setView(null));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (!view) return null;
  const msg = view.messages[lang];

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(view.url);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <section aria-labelledby="pool-share" data-testid="pool-share-card" className="mt-10 border-t border-slate-200 pt-8">
      <h2 id="pool-share" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        <Users className="h-5 w-5 text-emerald-600" aria-hidden />
        {s.heading}
      </h2>
      <p className="mt-2 text-sm text-slate-700">{s.intro}</p>

      <label htmlFor="pool-share-link" className="mt-4 block text-sm font-medium text-slate-900">
        {s.linkLabel}
      </label>
      <input
        id="pool-share-link"
        data-testid="pool-share-link"
        readOnly
        value={view.url}
        onFocus={(e) => e.currentTarget.select()}
        className="mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900"
      />

      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" onClick={copyLink} className={`${BTN} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus:ring-slate-400`}>
          <Copy className="h-4 w-4" aria-hidden />
          {copy === "done" ? s.copied : s.copyLink}
        </button>
        <a href={msg.whatsApp} target="_blank" rel="noopener noreferrer" data-testid="pool-share-whatsapp" className={`${BTN} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500`}>
          <MessageCircle className="h-4 w-4" aria-hidden />
          {s.shareWhatsApp}
        </a>
      </div>
      {/* A polite live region, not role="status": the host page has its own status line. */}
      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-slate-600">
        {copy === "failed" ? s.copyFailed : copy === "done" ? s.copied : ""}
      </p>

      <p className="mt-2 text-sm font-medium text-slate-900">{s.messageLabel}</p>
      <p data-testid="pool-share-message" className="mt-1 break-words rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">
        {msg.text}
      </p>
      <p className="mt-3 text-sm text-slate-600" data-testid="pool-share-privacy">
        {view.shownName ? s.recognitionOn(view.shownName) : s.recognitionOff}
      </p>
    </section>
  );
}
