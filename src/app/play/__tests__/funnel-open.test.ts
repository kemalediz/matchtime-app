/**
 * When the /play funnel counts "opened" (2026-11-12): once the visitor shows
 * a person is there, by a trusted tap, key, wheel or scroll, or by the page
 * having been on screen for 5 seconds in all. Link scanners that run script
 * under a browser's user agent opened the page in bursts 24 to 44 seconds
 * after a Facebook comment went up, and never touched it.
 */
import { describe, expect, it } from "vitest";
import { POOL_OPEN_PERSON_SIGNALS, POOL_OPEN_VISIBLE_MS, openGateNext, openGateStart, openGateWait, type OpenGate } from "../funnel-open";

const signal = (type: string, isTrusted = true) => ({ kind: "signal" as const, type, isTrusted });
const visibility = (visible: boolean, now: number) => ({ kind: "visibility" as const, visible, now });
const tick = (now: number) => ({ kind: "tick" as const, now });

/** Feed the inputs in order; which of them opened. */
function run(start: OpenGate, inputs: Parameters<typeof openGateNext>[1][]): { gate: OpenGate; opened: number[] } {
  let gate = start;
  const opened: number[] = [];
  inputs.forEach((input, i) => {
    const r = openGateNext(gate, input);
    gate = r.gate;
    if (r.open) opened.push(i);
  });
  return { gate, opened };
}

describe("a person's signal", () => {
  it("a trusted tap, touch, key, wheel or scroll opens at once", () => {
    expect([...POOL_OPEN_PERSON_SIGNALS].sort()).toEqual(["keydown", "pointerdown", "scroll", "touchstart", "wheel"]);
    for (const type of POOL_OPEN_PERSON_SIGNALS) {
      expect(openGateNext(openGateStart(0, true), signal(type)).open).toBe(true);
    }
  });

  it("a script's own event (untrusted) opens nothing", () => {
    for (const type of POOL_OPEN_PERSON_SIGNALS) {
      expect(openGateNext(openGateStart(0, true), signal(type, false)).open).toBe(false);
    }
  });

  it("other events open nothing, trusted or not: a mouse passing over, a focus, a load", () => {
    for (const type of ["mousemove", "pointermove", "focus", "load", "resize", "click"]) {
      expect(openGateNext(openGateStart(0, true), signal(type)).open).toBe(false);
    }
  });

  it("a signal while the page is hidden still opens: a person did it", () => {
    expect(openGateNext(openGateStart(0, false), signal("keydown")).open).toBe(true);
  });
});

describe("5 visible seconds", () => {
  it("opens once the page has been on screen for 5 seconds, not before", () => {
    const g = openGateStart(1_000, true);
    expect(openGateNext(g, tick(1_000 + POOL_OPEN_VISIBLE_MS - 1)).open).toBe(false);
    expect(openGateNext(g, tick(1_000 + POOL_OPEN_VISIBLE_MS)).open).toBe(true);
  });

  it("hidden time does not count: a tab opened in the background waits until it is looked at", () => {
    const { opened } = run(openGateStart(0, false), [tick(60_000), visibility(true, 60_000), tick(64_999), tick(65_000)]);
    expect(opened).toEqual([3]);
  });

  it("visible time adds up across stretches, and the time hidden between them is left out", () => {
    // 3 s on screen, 10 s away, 1.9 s back: 4.9 s. Then 0.1 s more: 5 s.
    const { opened } = run(openGateStart(0, true), [
      visibility(false, 3_000),
      tick(13_000),
      visibility(true, 13_000),
      tick(14_900),
      tick(15_000),
    ]);
    expect(opened).toEqual([4]);
  });

  it("a stretch that reached 5 seconds opens when it is noticed on hiding, if the clock was late", () => {
    const { opened } = run(openGateStart(0, true), [visibility(false, 7_000)]);
    expect(opened).toEqual([0]);
  });

  it("being shown again while already visible does not restart the count", () => {
    const { opened } = run(openGateStart(0, true), [visibility(true, 4_000), tick(5_000)]);
    expect(opened).toEqual([1]);
  });
});

describe("once only", () => {
  it("opens one time, whatever follows: more signals, more time, a start", () => {
    const { opened, gate } = run(openGateStart(0, true), [
      signal("scroll"),
      signal("keydown"),
      tick(10_000),
      visibility(false, 11_000),
      visibility(true, 12_000),
      { kind: "started" },
    ]);
    expect(opened).toEqual([0]);
    expect(gate.opened).toBe(true);
  });

  it("a start before any signal opens first, so a start never exists without an open", () => {
    const { opened } = run(openGateStart(0, true), [{ kind: "started" }, signal("keydown"), tick(9_000)]);
    expect(opened).toEqual([0]);
  });
});

describe("how long to wait for 5 visible seconds", () => {
  it("the visible time still missing while on screen", () => {
    expect(openGateWait(openGateStart(1_000, true), 1_000)).toBe(POOL_OPEN_VISIBLE_MS);
    expect(openGateWait(openGateStart(1_000, true), 3_500)).toBe(2_500);
    const back = run(openGateStart(0, true), [visibility(false, 2_000), visibility(true, 9_000)]).gate;
    expect(openGateWait(back, 9_000)).toBe(3_000);
  });

  it("nothing to wait for while hidden or once opened", () => {
    expect(openGateWait(openGateStart(0, false), 0)).toBeNull();
    expect(openGateWait(openGateNext(openGateStart(0, true), signal("wheel")).gate, 0)).toBeNull();
  });

  it("never negative when the clock ran late", () => {
    expect(openGateWait(openGateStart(0, true), 9_000)).toBe(0);
  });
});
