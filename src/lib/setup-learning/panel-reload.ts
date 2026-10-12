/**
 * F3, LEARNED SETUP: WHEN THE PANEL ON /admin/settings MAY LOAD AGAIN
 * (2026-10-12). Pure.
 *
 * The panel shows each suggestion against what the club has now
 * (suggestion-state.ts), so it must load again when that may have
 * changed. But a load is a server action, and a client's server actions
 * are sent one at a time: a load fired on every return to the tab can sit
 * in front of the organiser's "Go live" press, and on a phone, switching
 * between WhatsApp and the browser fires those events constantly. So:
 *
 *   "must"       the panel has just mounted, or a setting a suggestion is
 *                about was saved on this page. Loads now; if a load or a
 *                go-live request is in flight it waits for that ("later")
 *                and then loads once.
 *   "came-back"  the page was restored from the back-forward cache, or its
 *                tab was hidden for at least HIDDEN_MIN_MS and is shown
 *                again (the organiser went to another page or app). At
 *                most one every RELOAD_MIN_GAP_MS, the Go live banner's
 *                own gap; dropped while a load or a go-live is in flight.
 *
 * A plain return to the tab (a focus, or a hide and show within
 * HIDDEN_MIN_MS) loads nothing.
 */

/** The least time between two loads caused by coming back. The banner's PREVIEW_MIN_GAP_MS. */
export const RELOAD_MIN_GAP_MS = 5_000;
/** Hidden for less than this, nothing can have been changed elsewhere. */
export const HIDDEN_MIN_MS = 3_000;

export type ReloadWhy = "must" | "came-back";
export type ReloadDecision = "load" | "skip" | "later";

export function reloadDecision(a: {
  why: ReloadWhy;
  now: number;
  /** When the last load STARTED. */
  lastLoadAt: number;
  /** A load of the panel is in flight. */
  loading: boolean;
  /** The Go live banner's request is in flight (go-live-in-flight.ts). */
  goLiveInFlight: boolean;
}): ReloadDecision {
  if (a.loading || a.goLiveInFlight) return a.why === "must" ? "later" : "skip";
  if (a.why === "came-back" && a.now - a.lastLoadAt < RELOAD_MIN_GAP_MS) return "skip";
  return "load";
}

/** `hiddenAt`: when the tab was last hidden, or null if it was not. */
export function awayLongEnough(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt >= HIDDEN_MIN_MS;
}

/**
 * WHEN THE PANEL MAY SHOW WHAT A RELOAD BROUGHT BACK (2026-10-12).
 *
 * The panel is at the top of a long page, and a reload can change its
 * height: a suggestion's card (about 180px) goes when it is resolved, or
 * comes back. Everything below the panel then moves by that much. Found
 * live in the e2e suite: the organiser taps 'Switch on "The organisers
 * pick"', the page starts its smooth scroll down to that setting, they
 * save it, the card is removed while the scroll is still running, and
 * the scroll ends where the setting USED to be: the setting they have
 * just saved is off the top of the screen, and stays there. A browser's
 * scroll anchoring hides the shift only when the page is at rest, and
 * not every browser has it.
 *
 * So the panel never changes height where that can move what the
 * organiser is looking at. New data is shown only when
 *   the page has been still for SCROLL_SETTLE_MS (no scroll, and no jump
 *   to another part of the page begun), AND
 *   some of the panel is on the screen or below it. Wholly above the
 *   screen, it waits until the organiser scrolls back to it.
 *
 * `lastMotionAt`: when the page last scrolled or its hash last changed.
 * `panelBottom`: the bottom edge of the panel, from the top of the screen.
 */
export const SCROLL_SETTLE_MS = 150;

export function mayShowNow(a: { now: number; lastMotionAt: number; panelBottom: number }): boolean {
  return a.now - a.lastMotionAt >= SCROLL_SETTLE_MS && a.panelBottom > 0;
}
