"use client";

/**
 * The frame of a player pool page (slice L2): back link, language switch,
 * the card, the privacy link (a new tab, so a form on the page is never left). The privacy policy page's switch, reused in
 * look and behaviour.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { LANGS, LANG_LABELS, type Lang } from "@/lib/i18n/lang";
import { PolicyLink } from "@/components/policy-link";
import type { PoolPlayCopy } from "@/lib/i18n/pool-play";

export function PoolPageShell({ lang, onLang, copy, children }: { lang: Lang; onLang: (l: Lang) => void; copy: PoolPlayCopy; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <main lang={lang} className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12 break-words">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <Link href="/" className="text-sm font-medium text-blue-700 hover:underline">
            {copy.backHome}
          </Link>
          <div role="group" aria-label={copy.languageSwitchLabel} className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
            {LANGS.map((l) => (
              <button
                key={l}
                type="button"
                lang={l}
                aria-pressed={l === lang}
                onClick={() => onLang(l)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${l === lang ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-100"}`}
              >
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-6 sm:px-8 sm:py-8">{children}</div>
        <p className="mt-6 text-center text-sm">
          <PolicyLink className="text-blue-700 underline">{copy.privacyLink}</PolicyLink>
        </p>
      </main>
    </div>
  );
}
