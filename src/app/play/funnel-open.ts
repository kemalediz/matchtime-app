/**
 * When the /play funnel counts "opened" (2026-11-12; 2026-11-16), the pure
 * half of `funnel-beacon.tsx`. No DOM and no clock: it reads only what it is
 * handed.
 *
 * WHY. Until 12 November 2026 "opened" was sent as soon as the page loaded.
 * On 10 and 12 November opens arrived in bursts after a Facebook comment
 * linking /play went up: link scanners that run script under a normal
 * browser's user agent, so the server's fetcher list
 * (`link-preview-fetchers.ts`) lets them through. From 12 November 5
 * seconds on screen also counted as a person; on 15 November all 4 counted
 * opens were scanners that waited exactly 5000 ms. So since 16 November
 * time on screen counts nothing.
 *
 * THE RULE. Opened is sent once the visitor shows a person is there,
 * whichever comes first:
 *   - a trusted (`isTrusted`) pointerdown, touchstart, keydown, wheel or
 *     scroll: the browser made it for a person's tap, key or swipe; a
 *     script's `dispatchEvent` never is. (A scroll is trusted even when a
 *     script scrolled the page: a known gap, kept because a person's
 *     scroll is the commonest sign of reading on a phone.)
 *   - a person entered something in the form ("started", `funnel-start.ts`)
 *     before any of them: opened goes first, so a start never exists
 *     without an open.
 * Once only: after the gate has opened nothing opens it again. A page
 * nobody touches is never opened, however long it is on screen.
 *
 * The beacon sends what opened the page (`openTriggerOf`); the server
 * counts an open only with one of these (`readPoolPageBeacon`).
 */
import type { PoolOpenTrigger } from "@/lib/pool/visit-log-rules";

/** The events that show a person is there, when trusted. */
export const POOL_OPEN_PERSON_SIGNALS = ["pointerdown", "touchstart", "keydown", "wheel", "scroll"] as const;
const SIGNALS: ReadonlySet<string> = new Set(POOL_OPEN_PERSON_SIGNALS);

export interface OpenGate {
  readonly opened: boolean;
}

export type OpenGateInput = { kind: "signal"; type: string; isTrusted: boolean } | { kind: "started" };

/** The gate when the page mounts. */
export function openGateStart(): OpenGate {
  return { opened: false };
}

/** The gate after one input, and whether THIS input opened it. */
export function openGateNext(g: OpenGate, input: OpenGateInput): { gate: OpenGate; open: boolean } {
  if (g.opened) return { gate: g, open: false };
  const opens = input.kind === "started" || (input.isTrusted && SIGNALS.has(input.type));
  return opens ? { gate: { opened: true }, open: true } : { gate: g, open: false };
}

const SIGNAL_TRIGGER: Record<string, PoolOpenTrigger> = {
  pointerdown: "pointer",
  touchstart: "touch",
  keydown: "key",
  wheel: "wheel",
  scroll: "scroll",
} satisfies Record<(typeof POOL_OPEN_PERSON_SIGNALS)[number], PoolOpenTrigger>;

/** What the input that opened the gate is called in the beacon; null for a
 *  signal that never opens it. */
export function openTriggerOf(input: OpenGateInput): PoolOpenTrigger | null {
  return input.kind === "started" ? "before-start" : (SIGNAL_TRIGGER[input.type] ?? null);
}
