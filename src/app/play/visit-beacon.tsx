"use client";

/**
 * Counts this visit to /play (2026-11-03): one beacon after the page has
 * loaded, once per tab session for the same link, to POST /api/play/visit.
 * A link preview fetcher runs no script, so it never gets here. Fire and
 * forget: nothing waits for it, and nothing it does can break the page.
 */
import { useEffect } from "react";

const ENDPOINT = "/api/play/visit";

export function PoolVisitBeacon({ src, refCode }: { src: string | null; refCode: string | null }) {
  useEffect(() => {
    try {
      const key = `mt-play-visit:${src ?? ""}:${refCode ?? ""}`;
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // No storage (private mode): count it anyway.
    }
    try {
      const body = JSON.stringify({ src, ref: refCode });
      const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
      if (!sent) void fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
    } catch {
      // A visit is nice to know, never worth an error.
    }
  }, [src, refCode]);
  return null;
}
