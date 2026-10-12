/**
 * F3, learned setup: when may the panel on /admin/settings load its state
 * again? (2026-10-12, review of PR #239.)
 *
 * A reload is a server action, and a client's server actions are sent one
 * at a time: a reload fired every time the organiser comes back to the tab
 * can sit in front of their "Go live" press, and on a phone, switching
 * between WhatsApp and the browser fires those events constantly. Pure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_MIN_MS, RELOAD_MIN_GAP_MS, awayLongEnough, reloadDecision } from "../panel-reload";
import { GO_LIVE_SETTLED_EVENT, goLiveSettled, goLiveStarted, isGoLiveInFlight } from "@/lib/go-live-in-flight";

const T = 1_000_000;
const idle = { now: T, lastLoadAt: T - 60_000, loading: false, goLiveInFlight: false };

describe("reloadDecision", () => {
  it("the gap is the Go live banner's own (PREVIEW_MIN_GAP_MS in go-live-banner.tsx)", () => {
    expect(RELOAD_MIN_GAP_MS).toBe(5_000);
  });

  it("something was saved on the page (or the panel has just mounted): load, however recent the last one", () => {
    expect(reloadDecision({ ...idle, why: "must" })).toBe("load");
    expect(reloadDecision({ ...idle, why: "must", lastLoadAt: T - 1 })).toBe("load");
  });

  it("coming back: load, but at most once every five seconds", () => {
    expect(reloadDecision({ ...idle, why: "came-back" })).toBe("load");
    expect(reloadDecision({ ...idle, why: "came-back", lastLoadAt: T - RELOAD_MIN_GAP_MS })).toBe("load");
    expect(reloadDecision({ ...idle, why: "came-back", lastLoadAt: T - RELOAD_MIN_GAP_MS + 1 })).toBe("skip");
    expect(reloadDecision({ ...idle, why: "came-back", lastLoadAt: T })).toBe("skip");
  });

  it("never two at once: coming back is dropped, a save waits for the one in flight", () => {
    expect(reloadDecision({ ...idle, why: "came-back", loading: true })).toBe("skip");
    expect(reloadDecision({ ...idle, why: "must", loading: true })).toBe("later");
  });

  it("never beside a go-live request: coming back is dropped, a save waits until it has settled", () => {
    expect(reloadDecision({ ...idle, why: "came-back", goLiveInFlight: true })).toBe("skip");
    expect(reloadDecision({ ...idle, why: "must", goLiveInFlight: true })).toBe("later");
    expect(reloadDecision({ ...idle, why: "must", goLiveInFlight: true, loading: true })).toBe("later");
  });
});

describe("awayLongEnough: was the tab hidden long enough for anything to have changed?", () => {
  it("never hidden (a plain focus, or the events a browser fires on its own): no", () => {
    expect(awayLongEnough(null, T)).toBe(false);
  });
  it("a glance away: no; a few seconds on another page or app: yes", () => {
    expect(awayLongEnough(T - 500, T)).toBe(false);
    expect(awayLongEnough(T - HIDDEN_MIN_MS + 1, T)).toBe(false);
    expect(awayLongEnough(T - HIDDEN_MIN_MS, T)).toBe(true);
    expect(awayLongEnough(T - 600_000, T)).toBe(true);
  });
});

describe("the go-live request in flight, as the banner reports it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("in flight from start to settle, and settling says so once", () => {
    const dispatched: string[] = [];
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => dispatched.push(e.type) });
    expect(isGoLiveInFlight()).toBe(false);
    goLiveStarted();
    expect(isGoLiveInFlight()).toBe(true);
    expect(dispatched).toEqual([]);
    goLiveSettled();
    expect(isGoLiveInFlight()).toBe(false);
    expect(dispatched).toEqual([GO_LIVE_SETTLED_EVENT]);
  });

  it("a settle with nothing started changes nothing", () => {
    vi.stubGlobal("window", { dispatchEvent: () => true });
    goLiveSettled();
    expect(isGoLiveInFlight()).toBe(false);
    goLiveStarted();
    expect(isGoLiveInFlight()).toBe(true);
    goLiveSettled();
  });
});
