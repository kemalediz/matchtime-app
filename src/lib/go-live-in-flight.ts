/**
 * IS A GO-LIVE REQUEST IN FLIGHT ON THIS PAGE? (2026-10-12)
 *
 * A client's server actions are sent one at a time. The organiser's
 * "Go live" press on /admin/settings must never wait behind a background
 * refresh that some other part of the page started, so the Go live banner
 * says when its request starts and when it has settled, and anything on
 * the page that refreshes itself in the background asks first (today:
 * the learned-setup panel, setup-learning/panel-reload.ts).
 *
 * Module state, in the browser only: one page, one tab, one flag.
 */
let inFlight = 0;

/** Fired on `window` when a go-live request has settled, whatever its outcome. */
export const GO_LIVE_SETTLED_EVENT = "mt:go-live-settled";

export function goLiveStarted(): void {
  inFlight++;
}

export function goLiveSettled(): void {
  if (inFlight === 0) return;
  inFlight--;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(GO_LIVE_SETTLED_EVENT));
}

export function isGoLiveInFlight(): boolean {
  return inFlight > 0;
}
