"use client";

/**
 * The /play page's two funnel steps (visits 2026-11-03, steps 2026-11-04),
 * to POST /api/play/visit, each once per tab session for the same link:
 *   opened   once the page has loaded;
 *   started  on the first focus, change or tap inside the form.
 * Sent and confirmed are counted by the server where they happen
 * (`src/lib/pool/visits.ts`), never from here.
 *
 * It WRAPS the sign-up rather than living in it: the form's events bubble
 * up to this box (`display: contents`, so it adds no box to the layout),
 * and the form itself needs no hook. A link preview fetcher runs no script,
 * so it never gets here. Fire and forget: nothing waits for it, and nothing
 * it does can break the page.
 */
import { useEffect, useRef, type ReactNode, type SyntheticEvent } from "react";

const ENDPOINT = "/api/play/visit";

/** What a tap on counts as touching the form (Safari focuses no button on a tap). */
const CONTROL = "input, select, textarea, button, label, [role='button'], [role='checkbox'], [role='radio'], [role='switch']";

function send(step: "opened" | "started", src: string | null, refCode: string | null) {
  try {
    // The visit's key is the one /play has used since 2026-11-03, so a tab
    // already counted before the steps is not counted again.
    const key = `${step === "opened" ? "mt-play-visit" : "mt-play-started"}:${src ?? ""}:${refCode ?? ""}`;
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // No storage (private mode): count it anyway.
  }
  try {
    const body = JSON.stringify({ src, ref: refCode, step });
    const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
    if (!sent) void fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    // A count is nice to know, never worth an error.
  }
}

export function PoolFunnelBeacon({ src, refCode, children }: { src: string | null; refCode: string | null; children: ReactNode }) {
  useEffect(() => send("opened", src, refCode), [src, refCode]);

  const started = useRef(false);
  const touched = (e: SyntheticEvent) => {
    if (started.current) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest("form")) return;
    if (e.type === "click" && !target.closest(CONTROL)) return;
    started.current = true;
    send("started", src, refCode);
  };

  return (
    <div className="contents" onFocusCapture={touched} onChangeCapture={touched} onClickCapture={touched}>
      {children}
    </div>
  );
}
