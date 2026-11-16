"use client";

/**
 * The /play page's two funnel steps (visits 2026-11-03, steps 2026-11-04),
 * to POST /api/play/visit, each once per tab session for the same link:
 *   opened   once the visitor shows a person is there (2026-11-12): a
 *            trusted tap, touch, key, wheel or scroll, or a start, whichever
 *            comes first. Time on screen counts nothing since 2026-11-16
 *            (`funnel-open.ts`, which says why: link scanners on 10, 12
 *            and 15 November 2026);
 *   started  once a person first ENTERS something in the form (2026-11-06):
 *            the first trusted input or change on a form control that
 *            really changed its value, such as typing a character, picking
 *            a day or ticking a box. Focus alone, a bare click and a
 *            script's synthetic event count nothing (`funnel-start.ts`,
 *            which says why: a scanner on 6 November 2026).
 * Sent and confirmed are counted by the server where they happen
 * (`src/lib/pool/visits.ts`), never from here. The opened beacon also says
 * what opened the page, for the server's daily totals
 * (`src/lib/pool/visit-log-rules.ts`); nothing else about the visit is sent.
 *
 * It WRAPS the sign-up rather than living in it: the form's events bubble
 * up to this box (`display: contents`, so it adds no box to the layout),
 * and the form itself needs no hook. A link preview fetcher runs no script,
 * so it never gets here. Fire and forget: nothing waits for it, and nothing
 * it does can break the page.
 */
import { useEffect, useRef, type ReactNode, type SyntheticEvent } from "react";
import { funnelControlValue, isPersonEntry } from "./funnel-start";
import { POOL_OPEN_PERSON_SIGNALS, openGateNext, openGateStart, openTriggerOf, type OpenGateInput } from "./funnel-open";
import type { PoolOpenTrigger } from "@/lib/pool/visit-log-rules";

const ENDPOINT = "/api/play/visit";

// The visit's key is the one /play has used since 2026-11-03, so a tab
// already counted before the steps (or before 2026-11-12's gate) is not
// counted again.
const stepKey = (step: "opened" | "started", src: string | null, refCode: string | null) =>
  `${step === "opened" ? "mt-play-visit" : "mt-play-started"}:${src ?? ""}:${refCode ?? ""}`;

/** Already sent in this tab session? False when there is no storage. */
function sentBefore(step: "opened" | "started", src: string | null, refCode: string | null): boolean {
  try {
    return !!window.sessionStorage.getItem(stepKey(step, src, refCode));
  } catch {
    return false;
  }
}

function send(step: "opened" | "started", src: string | null, refCode: string | null, trigger: PoolOpenTrigger | null) {
  try {
    const key = stepKey(step, src, refCode);
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // No storage (private mode): count it anyway.
  }
  try {
    const body = JSON.stringify({ src, ref: refCode, step, trigger });
    const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
    if (!sent) void fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    // A count is nice to know, never worth an error.
  }
}

export function PoolFunnelBeacon({ src, refCode, children }: { src: string | null; refCode: string | null; children: ReactNode }) {
  /** Open now if not yet: a start arriving first opens it (set while the gate listens). */
  const openBeforeStart = useRef<(() => void) | null>(null);
  // The opened gate: listens until a person shows he is there, then sends
  // once and stops listening. A tab that already sent it does not listen.
  useEffect(() => {
    if (sentBefore("opened", src, refCode)) return;
    const LISTEN = { capture: true, passive: true } as const;
    let gate = openGateStart();
    const stop = () => {
      for (const type of POOL_OPEN_PERSON_SIGNALS) window.removeEventListener(type, onSignal, LISTEN);
      openBeforeStart.current = null;
    };
    const apply = (input: OpenGateInput) => {
      const next = openGateNext(gate, input);
      gate = next.gate;
      if (!next.open) return;
      stop();
      send("opened", src, refCode, openTriggerOf(input));
    };
    function onSignal(e: Event) {
      apply({ kind: "signal", type: e.type, isTrusted: e.isTrusted });
    }
    for (const type of POOL_OPEN_PERSON_SIGNALS) window.addEventListener(type, onSignal, LISTEN);
    openBeforeStart.current = () => apply({ kind: "started" });
    return stop;
  }, [src, refCode]);

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
    openBeforeStart.current?.();
    send("started", src, refCode, null);
  };

  return (
    <div className="contents" onFocusCapture={focused} onClickCapture={clicked} onInputCapture={entered} onChangeCapture={entered}>
      {children}
    </div>
  );
}
