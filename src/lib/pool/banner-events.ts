/**
 * "His pool state just changed" (2026-10-28). CLIENT-SAFE.
 *
 * The pool banner reads its view from `GET /api/pool-banner` on each new
 * page. Joining on the "Play elsewhere too" card, answering its claim,
 * pausing, stopping or deleting on /play/manage, and "Not interested" all
 * happen without a page change, so whatever changes his banner says so
 * here and the banner reads again:
 *
 *   this tab    a window event
 *   his other   a BroadcastChannel message (same browser, same site)
 *   tabs
 *   coming      the page becoming visible again (back from WhatsApp, where
 *   back        his number is verified, or from another device)
 *
 * No state of its own: the server stays the only judge of which banner.
 */
export const POOL_STATE_CHANGED_EVENT = "mt:pool-state-changed";
export const POOL_STATE_CHANNEL = "mt:pool-state";

/** This tab's own messages come back on its own channel; it already heard them. */
const THIS_TAB = Math.random().toString(36).slice(2);

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(POOL_STATE_CHANNEL);
  } catch {
    return null;
  }
}

/** Tell this tab and his other tabs that his pool state changed. */
export function announcePoolStateChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(POOL_STATE_CHANGED_EVENT));
  const ch = channel();
  if (!ch) return;
  try {
    ch.postMessage({ from: THIS_TAB });
  } finally {
    ch.close();
  }
}

/** Call `onChange` whenever his pool state may have changed; returns the unsubscribe. */
export function subscribePoolStateChanged(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fire = () => onChange();
  const onVisible = () => {
    if (document.visibilityState === "visible") onChange();
  };
  window.addEventListener(POOL_STATE_CHANGED_EVENT, fire);
  document.addEventListener("visibilitychange", onVisible);
  const ch = channel();
  if (ch) ch.onmessage = (e: MessageEvent) => (e.data as { from?: string } | null)?.from !== THIS_TAB && onChange();
  return () => {
    window.removeEventListener(POOL_STATE_CHANGED_EVENT, fire);
    document.removeEventListener("visibilitychange", onVisible);
    ch?.close();
  };
}
