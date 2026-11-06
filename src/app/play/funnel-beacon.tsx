"use client";

/**
 * The /play page's two funnel steps (visits 2026-11-03, steps 2026-11-04),
 * to POST /api/play/visit, each once per tab session for the same link:
 *   opened   once the page has loaded;
 *   started  once a person first ENTERS something in the form (2026-11-06):
 *            the first trusted input or change on a form control that
 *            really changed its value, such as typing a character, picking
 *            a day or ticking a box. Focus alone, a bare click and a
 *            script's synthetic event count nothing (`funnel-start.ts`,
 *            which says why: a scanner on 6 November 2026).
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
import { funnelControlValue, isPersonEntry } from "./funnel-start";

const ENDPOINT = "/api/play/visit";

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
  /** What each control held when first focused, to tell a real change. Only read, never written back. */
  const before = useRef(new WeakMap<object, string>());
  /** The latest click and whether a person made it: a tick box counts only when its click was a person's. */
  const lastClick = useRef<{ target: EventTarget; trusted: boolean } | null>(null);
  const focused = (e: SyntheticEvent) => {
    if (started.current || before.current.has(e.target)) return;
    const value = funnelControlValue(e.target);
    if (value !== null) before.current.set(e.target, value);
  };
  const clicked = (e: SyntheticEvent) => {
    if (!started.current) lastClick.current = { target: e.target, trusted: e.nativeEvent.isTrusted };
  };
  const entered = (e: SyntheticEvent) => {
    if (started.current) return;
    const click = lastClick.current?.target === e.target ? lastClick.current.trusted : undefined;
    if (!isPersonEntry({ type: e.type, isTrusted: e.nativeEvent.isTrusted, target: e.target }, { before: before.current.get(e.target), clickTrusted: click })) return;
    started.current = true;
    send("started", src, refCode);
  };

  return (
    <div className="contents" onFocusCapture={focused} onClickCapture={clicked} onInputCapture={entered} onChangeCapture={entered}>
      {children}
    </div>
  );
}
