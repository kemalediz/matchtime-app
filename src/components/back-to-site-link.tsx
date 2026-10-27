"use client";

/**
 * "Back to MatchTime" that returns an in-site reader to where he came from
 * (`backAction`), else goes home. A plain link to "/" until clicked, so it
 * works with scripts off and on a middle click.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { backAction } from "@/lib/back-nav";

export function BackToSiteLink({ className, children }: { className?: string; children: ReactNode }) {
  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const action = backAction({
      referrer: document.referrer,
      origin: window.location.origin,
      historyLength: window.history.length,
      here: window.location.pathname,
    });
    if (action.kind === "home") return;
    e.preventDefault();
    if (action.kind === "back") {
      window.history.back();
      return;
    }
    window.close();
    // Still here: the browser would not close the tab.
    window.setTimeout(() => window.location.assign(action.fallback), 150);
  }
  return (
    <Link href="/" className={className} onClick={onClick}>
      {children}
    </Link>
  );
}
