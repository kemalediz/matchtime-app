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
