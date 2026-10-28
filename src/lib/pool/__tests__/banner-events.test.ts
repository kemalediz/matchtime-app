/**
 * The "pool state changed" signal the pool banner listens to: this tab,
 * his other tabs, and the page becoming visible again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcePoolStateChanged, POOL_STATE_CHANNEL, POOL_STATE_CHANGED_EVENT, subscribePoolStateChanged } from "../banner-events";

type Doc = EventTarget & { visibilityState: "visible" | "hidden" };
let doc: Doc;

beforeEach(() => {
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", doc);
});
afterEach(() => vi.unstubAllGlobals());

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("pool state changed", () => {
  it("an announce in this tab reaches the subscriber at once, and once only", async () => {
    const seen = vi.fn();
    const off = subscribePoolStateChanged(seen);
    announcePoolStateChanged();
    expect(seen).toHaveBeenCalledTimes(1);
    await tick();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("a message from his other tab reaches the subscriber", async () => {
    const seen = vi.fn();
    const off = subscribePoolStateChanged(seen);
    const otherTab = new BroadcastChannel(POOL_STATE_CHANNEL);
    otherTab.postMessage({ from: "another-tab" });
    otherTab.close();
    await tick();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("the page becoming visible again reads again; going hidden does not", () => {
    const seen = vi.fn();
    const off = subscribePoolStateChanged(seen);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(seen).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("after unsubscribing nothing reaches it", async () => {
    const seen = vi.fn();
    subscribePoolStateChanged(seen)();
    window.dispatchEvent(new Event(POOL_STATE_CHANGED_EVENT));
    doc.dispatchEvent(new Event("visibilitychange"));
    const otherTab = new BroadcastChannel(POOL_STATE_CHANNEL);
    otherTab.postMessage({ from: "another-tab" });
    otherTab.close();
    await tick();
    expect(seen).not.toHaveBeenCalled();
  });

  it("does nothing on the server", () => {
    vi.stubGlobal("window", undefined);
    expect(() => announcePoolStateChanged()).not.toThrow();
    expect(() => subscribePoolStateChanged(() => {})()).not.toThrow();
  });
});
