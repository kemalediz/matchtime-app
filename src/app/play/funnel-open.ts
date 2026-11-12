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
 */

/** The events that show a person is there, when trusted. */
export const POOL_OPEN_PERSON_SIGNALS = ["pointerdown", "touchstart", "keydown", "wheel", "scroll"] as const;
const SIGNALS: ReadonlySet<string> = new Set(POOL_OPEN_PERSON_SIGNALS);

/** On screen this long in all (ms) and it is a person reading. */
export const POOL_OPEN_VISIBLE_MS = 5_000;

export interface OpenGate {
  readonly opened: boolean;
  /** Visible time banked from stretches that have ended (ms). */
  readonly visibleMs: number;
  /** When the current visible stretch began, or null while hidden. */
  readonly visibleSince: number | null;
}

export type OpenGateInput =
  | { kind: "signal"; type: string; isTrusted: boolean }
  | { kind: "visibility"; visible: boolean; now: number }
  | { kind: "tick"; now: number }
  | { kind: "started" };

/** The gate when the page mounts, `now` on any one clock (ms). */
export function openGateStart(now: number, visible: boolean): OpenGate {
  return { opened: false, visibleMs: 0, visibleSince: visible ? now : null };
}

function visibleSoFar(g: OpenGate, now: number): number {
  return g.visibleMs + (g.visibleSince === null ? 0 : Math.max(now - g.visibleSince, 0));
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
      if (input.visible) {
        // Shown again while already visible: the stretch runs on.
        return { gate: g.visibleSince === null ? { ...g, visibleSince: input.now } : g, open: false };
      }
      const banked: OpenGate = { ...g, visibleMs: visibleSoFar(g, input.now), visibleSince: null };
      // A stretch that reached 5 seconds while the timer ran late still counts.
      return banked.visibleMs >= POOL_OPEN_VISIBLE_MS ? open(banked) : { gate: banked, open: false };
    }
  }
}

/** How long (ms) until 5 visible seconds, if the page stays on screen; null
 *  while hidden or once opened, when there is nothing to wait for. */
export function openGateWait(g: OpenGate, now: number): number | null {
  if (g.opened || g.visibleSince === null) return null;
  return Math.max(POOL_OPEN_VISIBLE_MS - visibleSoFar(g, now), 0);
}
