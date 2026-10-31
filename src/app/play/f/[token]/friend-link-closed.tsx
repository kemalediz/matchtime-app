"use client";

/**
 * A friend link that no longer works (2026-10-31): used, its game started
 * or was called off, or not one we signed. One line, and the plain pool
 * sign-up. In the browser's language, with the switch.
 */
import Link from "next/link";
import { useState } from "react";
import { PoolPageShell } from "@/components/pool/pool-page-shell";
import { useBrowserLang } from "@/lib/i18n/browser-lang";
import { friendLinkCopy } from "@/lib/i18n/friend-link";
import type { Lang } from "@/lib/i18n/lang";
import { poolPageCopy } from "@/lib/pool/page-copy";

export function FriendLinkClosed({ state }: { state: "used" | "started" | "called-off" | "invalid" }) {
  const browserLang = useBrowserLang();
  const [chosen, setChosen] = useState<Lang | null>(null);
  const lang = chosen ?? browserLang;
  const c = friendLinkCopy(lang);
  const line = { used: c.page_used, started: c.page_started, "called-off": c.page_called_off, invalid: c.page_invalid }[state];
  return (
    <PoolPageShell lang={lang} onLang={setChosen} copy={poolPageCopy(lang)}>
      <div data-testid="friend-link-closed" data-state={state}>
        <p className="text-lg font-semibold text-slate-900">{line}</p>
        <p className="mt-3 text-sm text-slate-700">{c.page_pool_hint}</p>
        <Link href="/play" className="mt-5 inline-flex rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">
          {c.page_pool_cta}
        </Link>
      </div>
    </PoolPageShell>
  );
}
