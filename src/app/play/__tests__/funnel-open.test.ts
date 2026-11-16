/**
 * When the /play funnel counts "opened" (2026-11-12; 2026-11-16): only once
 * the visitor shows a person is there, by a trusted tap, touch, key, wheel
 * or scroll, or by entering something in the form first. Time on screen no
 * longer counts: on 15 November 2026 all 4 counted opens were scanners that
 * waited exactly 5000 ms, the old visible-time rule, and never touched the
 * page.
 */
import { describe, expect, it } from "vitest";
import { POOL_OPEN_PERSON_SIGNALS, openGateNext, openGateStart, openTriggerOf, type OpenGate, type OpenGateInput } from "../funnel-open";
import { POOL_OPEN_TRIGGERS, readPoolPageBeacon } from "@/lib/pool/visit-log-rules";
import * as gate from "../funnel-open";

const signal = (type: string, isTrusted = true) => ({ kind: "signal" as const, type, isTrusted });

/** Feed the inputs in order; which of them opened. */
function run(start: OpenGate, inputs: OpenGateInput[]): { gate: OpenGate; opened: number[] } {
  let g = start;
  const opened: number[] = [];
  inputs.forEach((input, i) => {
    const r = openGateNext(g, input);
    g = r.gate;
    if (r.open) opened.push(i);
  });
  return { gate: g, opened };
}

describe("a person's signal", () => {
  it("a trusted tap, touch, key, wheel or scroll opens at once", () => {
    expect([...POOL_OPEN_PERSON_SIGNALS].sort()).toEqual(["keydown", "pointerdown", "scroll", "touchstart", "wheel"]);
    for (const type of POOL_OPEN_PERSON_SIGNALS) {
      expect(openGateNext(openGateStart(), signal(type)).open).toBe(true);
    }
  });

  it("a script's own event (untrusted) opens nothing", () => {
    for (const type of POOL_OPEN_PERSON_SIGNALS) {
      expect(openGateNext(openGateStart(), signal(type, false)).open).toBe(false);
    }
  });

  it("other events open nothing, trusted or not: a mouse passing over, a focus, a load, the page being shown", () => {
    for (const type of ["mousemove", "pointermove", "focus", "load", "resize", "click", "visibilitychange"]) {
      expect(openGateNext(openGateStart(), signal(type)).open).toBe(false);
    }
  });
});

describe("time on screen opens nothing (2026-11-16)", () => {
  it("the gate has no clock: no visible-time rule, no wait, no timer to schedule", () => {
    expect(Object.keys(gate).sort()).toEqual(["POOL_OPEN_PERSON_SIGNALS", "openGateNext", "openGateStart", "openTriggerOf"]);
    expect(openGateStart()).toEqual({ opened: false });
  });

  it("a page left open, shown and hidden, with no tap, key or scroll, never opens", () => {
    const { opened } = run(openGateStart(), [signal("visibilitychange"), signal("focus"), signal("mousemove"), signal("load")]);
    expect(opened).toEqual([]);
  });
});

describe("once only", () => {
  it("opens one time, whatever follows: more signals, a start", () => {
    const { opened, gate: g } = run(openGateStart(), [signal("scroll"), signal("keydown"), { kind: "started" }, signal("pointerdown")]);
    expect(opened).toEqual([0]);
    expect(g.opened).toBe(true);
  });

  it("a start before any signal opens first, so a start never exists without an open", () => {
    const { opened } = run(openGateStart(), [{ kind: "started" }, signal("keydown")]);
    expect(opened).toEqual([0]);
  });
});

describe("what opened it, sent with the beacon", () => {
  it("names the signal or the start; every name is one the server accepts as a well-formed open", () => {
    expect(openTriggerOf(signal("pointerdown"))).toBe("pointer");
    expect(openTriggerOf(signal("touchstart"))).toBe("touch");
    expect(openTriggerOf(signal("keydown"))).toBe("key");
    expect(openTriggerOf(signal("wheel"))).toBe("wheel");
    expect(openTriggerOf(signal("scroll"))).toBe("scroll");
    expect(openTriggerOf({ kind: "started" })).toBe("before-start");
    expect(openTriggerOf(signal("mousemove"))).toBeNull();
    const sent = [...POOL_OPEN_PERSON_SIGNALS.map((type) => openTriggerOf(signal(type))), openTriggerOf({ kind: "started" })];
    expect(new Set(sent)).toEqual(new Set(POOL_OPEN_TRIGGERS));
    for (const trigger of sent) expect(readPoolPageBeacon({ step: "opened", trigger })).toEqual({ step: "opened", trigger });
  });
});
