/**
 * When the /play funnel counts "opened" (2026-11-12), the pure half of
 * `funnel-beacon.tsx`. No DOM and no clock of its own: it reads only what
 * it is handed.
 *
 * WHY. Until 12 November 2026 "opened" was sent as soon as the page loaded.
 * On 10 November 6 opens arrived 24 to 44 seconds after a Facebook comment
 * linking /play went up, in a burst of identical browsers, and the same on
 * the 12th: link scanners that run script under a normal browser's user
 * agent, so the server's fetcher list (`link-preview-fetchers.ts`) lets
 * them through. They never touch the page.
 *
 * THE RULE. Opened is sent once the visitor shows a person is there,
 * whichever comes first:
 *   - a trusted (`isTrusted`) pointerdown, touchstart, keydown, wheel or
 *     scroll: the browser made it for a person's tap, key or swipe; a
 *     script's `dispatchEvent` never is. (A scroll is trusted even when a
 *     script scrolled the page: a known gap, kept because a person's
 *     scroll is the commonest sign of reading on a phone.)
 *   - the page has been on screen (`visibilityState` "visible") for 5
 *     seconds in all. Time in a background tab does not count, so a link
 *     opened in a tab nobody looks at waits until someone does.
 *   - a person entered something in the form ("started", `funnel-start.ts`)
 *     before either: opened goes first, so a start never exists without an
 *     open.
 * Once only: after the gate has opened nothing opens it again.
 *
 * WHAT OPENED IT, AND THE TIME ON SCREEN (2026-11-13): the beacon sends
 * which of these opened the page (`openTriggerOf`) and how long the page
 * had been on screen (`visibleSoFar`, on the page's own visible clock), for
 * the visit log (`src/lib/pool/visit-log-rules.ts`), kept 90 days.
 */
import type { PoolOpenTrigger } from "@/lib/pool/visit-log-rules";


/** The events that show a person is there, when trusted. */
export const POOL_OPEN_PERSON_SIGNALS = ["pointerdown", "touchstart", "keydown", "wheel", "scroll"] as const;
const SIGNALS: ReadonlySet<string> = new Set(POOL_OPEN_PERSON_SIGNALS);

/** On screen this long in all (ms) and it is a person reading. */
export const POOL_OPEN_VISIBLE_MS = 5_000;

/** Time on screen, on any one clock (ms). */
export interface VisibleClock {
  /** Visible time banked from stretches that have ended (ms). */
  readonly visibleMs: number;
  /** When the current visible stretch began, or null while hidden. */
  readonly visibleSince: number | null;
}

export interface OpenGate extends VisibleClock {
  readonly opened: boolean;
}

export type OpenGateInput =
  | { kind: "signal"; type: string; isTrusted: boolean }
  | { kind: "visibility"; visible: boolean; now: number }
  | { kind: "tick"; now: number }
  | { kind: "started" };

export function visibleClockStart(now: number, visible: boolean): VisibleClock {
  return { visibleMs: 0, visibleSince: visible ? now : null };
}

/** The time on screen so far (ms). */
export function visibleSoFar(c: VisibleClock, now: number): number {
  return c.visibleMs + (c.visibleSince === null ? 0 : Math.max(now - c.visibleSince, 0));
}

/** The clock once the page is shown or hidden: hiding banks the stretch;
 *  shown again while already visible, the stretch runs on. */
export function visibleClockNext<C extends VisibleClock>(c: C, visible: boolean, now: number): C {
  if (visible) return c.visibleSince === null ? { ...c, visibleSince: now } : c;
  return { ...c, visibleMs: visibleSoFar(c, now), visibleSince: null };
}

/** The gate when the page mounts, `now` on any one clock (ms). */
export function openGateStart(now: number, visible: boolean): OpenGate {
  return { opened: false, ...visibleClockStart(now, visible) };
}

/** The gate after one input, and whether THIS input opened it. */
export function openGateNext(g: OpenGate, input: OpenGateInput): { gate: OpenGate; open: boolean } {
  if (g.opened) return { gate: g, open: false };
  const open = (gate: OpenGate) => ({ gate: { ...gate, opened: true }, open: true });
  switch (input.kind) {
    case "signal":
      return input.isTrusted && SIGNALS.has(input.type) ? open(g) : { gate: g, open: false };
    case "started":
      return open(g);
    case "tick":
      return visibleSoFar(g, input.now) >= POOL_OPEN_VISIBLE_MS ? open(g) : { gate: g, open: false };
    case "visibility": {
      const next = visibleClockNext(g, input.visible, input.now);
      // A stretch that reached 5 seconds while the timer ran late still counts.
      return !input.visible && next.visibleMs >= POOL_OPEN_VISIBLE_MS ? open(next) : { gate: next, open: false };
    }
  }
}

const SIGNAL_TRIGGER: Record<string, PoolOpenTrigger> = {
  pointerdown: "pointer",
  touchstart: "touch",
  keydown: "key",
  wheel: "wheel",
  scroll: "scroll",
} satisfies Record<(typeof POOL_OPEN_PERSON_SIGNALS)[number], PoolOpenTrigger>;

/** What the input that opened the gate is called in the visit log; null
 *  for a signal that never opens it. */
export function openTriggerOf(input: OpenGateInput): PoolOpenTrigger | null {
  switch (input.kind) {
    case "signal":
      return SIGNAL_TRIGGER[input.type] ?? null;
    case "started":
      return "before-start";
    case "tick":
    case "visibility":
      return "visible-time";
  }
}

/** How long (ms) until 5 visible seconds, if the page stays on screen; null
 *  while hidden or once opened, when there is nothing to wait for. */
export function openGateWait(g: OpenGate, now: number): number | null {
  if (g.opened || g.visibleSince === null) return null;
  return Math.max(POOL_OPEN_VISIBLE_MS - visibleSoFar(g, now), 0);
}
