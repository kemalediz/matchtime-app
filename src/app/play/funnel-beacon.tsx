"use client";

/**
 * The /play page's two funnel steps (visits 2026-11-03, steps 2026-11-04),
 * to POST /api/play/visit, each once per tab session for the same link:
 *   opened   once the visitor shows a person is there (2026-11-12): a
 *            trusted tap, key, wheel or scroll, or 5 seconds on screen in
 *            all, or a start, whichever comes first (`funnel-open.ts`,
 *            which says why: link scanners on 10 and 12 November 2026);
 *   started  once a person first ENTERS something in the form (2026-11-06):
 *            the first trusted input or change on a form control that
 *            really changed its value, such as typing a character, picking
 *            a day or ticking a box. Focus alone, a bare click and a
 *            script's synthetic event count nothing (`funnel-start.ts`,
 *            which says why: a scanner on 6 November 2026).
 * Sent and confirmed are counted by the server where they happen
 * (`src/lib/pool/visits.ts`), never from here. Each beacon also carries
 * what opened the page (opened only) and how long it had been on screen
 * (2026-11-13), for the visit log the server keeps 90 days
 * (`src/lib/pool/visit-log-rules.ts`).
 *
 * It WRAPS the sign-up rather than living in it: the form's events bubble
 * up to this box (`display: contents`, so it adds no box to the layout),
 * and the form itself needs no hook. A link preview fetcher runs no script,
 * so it never gets here. Fire and forget: nothing waits for it, and nothing
 * it does can break the page.
 */
import { useEffect, useRef, type ReactNode, type SyntheticEvent } from "react";
import { funnelControlValue, isPersonEntry } from "./funnel-start";
import {
  POOL_OPEN_PERSON_SIGNALS,
  openGateNext,
  openGateStart,
  openGateWait,
  openTriggerOf,
  visibleClockNext,
  visibleClockStart,
  visibleSoFar,
  type OpenGateInput,
  type VisibleClock,
} from "./funnel-open";
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

/** For the visit log (2026-11-13): what opened the page (opened only) and
 *  how long it had been on screen. The server checks and clamps both. */
type BeaconDetail = { trigger: PoolOpenTrigger | null; visibleMs: number };

function send(step: "opened" | "started", src: string | null, refCode: string | null, detail: BeaconDetail) {
  try {
    const key = stepKey(step, src, refCode);
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // No storage (private mode): count it anyway.
  }
  try {
    const body = JSON.stringify({ src, ref: refCode, step, trigger: detail.trigger, visibleMs: Math.round(detail.visibleMs) });
    const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
    if (!sent) void fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    // A count is nice to know, never worth an error.
  }
}

export function PoolFunnelBeacon({ src, refCode, children }: { src: string | null; refCode: string | null; children: ReactNode }) {
  /** Open now if not yet: a start arriving first opens it (set while the gate listens). */
  const openBeforeStart = useRef<(() => void) | null>(null);
  // The page's time on screen since it mounted, for both beacons (the
  // gate's own clock stops when it opens). Declared first, so it is
  // running before the gate below can send.
  const pageClock = useRef<VisibleClock | null>(null);
  const visibleNow = () => (pageClock.current ? visibleSoFar(pageClock.current, performance.now()) : 0);
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    pageClock.current = visibleClockStart(performance.now(), visible());
    const onVisibility = () => {
      if (pageClock.current) pageClock.current = visibleClockNext(pageClock.current, visible(), performance.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  // The opened gate: listens until a person shows he is there, then sends
  // once and stops listening. A tab that already sent it does not listen.
  useEffect(() => {
    if (sentBefore("opened", src, refCode)) return;
    const clock = () => performance.now();
    const LISTEN = { capture: true, passive: true } as const;
    let gate = openGateStart(clock(), document.visibilityState === "visible");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      for (const type of POOL_OPEN_PERSON_SIGNALS) window.removeEventListener(type, onSignal, LISTEN);
      document.removeEventListener("visibilitychange", onVisibility);
      openBeforeStart.current = null;
    };
    const apply = (input: OpenGateInput) => {
      const next = openGateNext(gate, input);
      gate = next.gate;
      if (!next.open) return;
      stop();
      send("opened", src, refCode, { trigger: openTriggerOf(input), visibleMs: visibleNow() });
    };
    /** Wake when 5 visible seconds will have passed, if the page stays on
     *  screen; again if the timer woke a moment early. */
    const schedule = () => {
      clearTimeout(timer);
      const wait = openGateWait(gate, clock());
      if (wait === null) return;
      timer = setTimeout(() => {
        apply({ kind: "tick", now: clock() });
        if (!gate.opened) schedule();
      }, wait);
    };
    function onSignal(e: Event) {
      apply({ kind: "signal", type: e.type, isTrusted: e.isTrusted });
    }
    function onVisibility() {
      apply({ kind: "visibility", visible: document.visibilityState === "visible", now: clock() });
      if (!gate.opened) schedule();
    }
    for (const type of POOL_OPEN_PERSON_SIGNALS) window.addEventListener(type, onSignal, LISTEN);
    document.addEventListener("visibilitychange", onVisibility);
    openBeforeStart.current = () => apply({ kind: "started" });
    schedule();
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
    send("started", src, refCode, { trigger: null, visibleMs: visibleNow() });
  };

  return (
    <div className="contents" onFocusCapture={focused} onClickCapture={clicked} onInputCapture={entered} onChangeCapture={entered}>
      {children}
    </div>
  );
}
