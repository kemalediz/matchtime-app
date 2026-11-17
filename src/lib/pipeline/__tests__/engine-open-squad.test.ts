/**
 * OPEN SQUAD IN THE ENGINE (2026-11-17, the Vets: no squad limit, no
 * bench). Every IN is in whatever the count, with ✅; a "bench" request has
 * no bench to go to, so it is an IN too; an OUT shrinks the squad. The
 * react and the write say the same thing, because `applyClaim` asks the
 * same rule `registerAttendance` does (`canTakeFreePlace`).
 */
import { describe, it, expect } from "vitest";
import { decide } from "./support/stub-picks";
import { NOW, attendanceFacts, claim, confirmedCount, msg, statusOf, world } from "./helpers";

const FOURTEEN = ["abid", "mustafa", "idris", "elvin", "kemal", "sait", "faris", "shaz", "adam", "efat", "usama", "karahan", "zair", "najib"];
const open = { features: { openSquad: true } };

const selfIn = (from: string) => msg({ from, body: "in", route: "self_att", facts: attendanceFacts([claim({})]) });
const selfOut = (from: string) => msg({ from, body: "out", route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) });
const selfBench = (from: string) => msg({ from, body: "bench me", route: "self_att", facts: attendanceFacts([claim({ polarity: "bench" })]) });

describe("open squad", () => {
  it("an IN past the format's places is CONFIRMED with ✅, never the bench", () => {
    const state = world({ confirmed: FOURTEEN, ...open });
    expect(confirmedCount(state)).toBe(14);
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("CONFIRMED");
    expect(r.outcomes[0].react).toBe("✅");
    expect(r.writes.find((x) => x.kind === "attendance")).toMatchObject({ status: "CONFIRMED" });
  });

  it("a bench request is an IN: there is no bench", () => {
    const state = world({ confirmed: FOURTEEN, ...open });
    const r = decide({ now: NOW, state, messages: [selfBench("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("CONFIRMED");
    expect(r.writes.find((x) => x.kind === "attendance")).toMatchObject({ status: "CONFIRMED", explicitBench: false });
  });

  it("a player in the squad asking for the bench stays in", () => {
    const state = world({ confirmed: FOURTEEN, ...open });
    const r = decide({ now: NOW, state, messages: [selfBench("kemal")] });
    expect(statusOf(r.nextState, "kemal")).toBe("CONFIRMED");
    expect(r.writes.filter((x) => x.kind === "attendance")).toHaveLength(0);
  });

  it("an OUT shrinks the squad", () => {
    const state = world({ confirmed: FOURTEEN, ...open });
    const r = decide({ now: NOW, state, messages: [selfOut("kemal")] });
    expect(statusOf(r.nextState, "kemal")).toBe("DROPPED");
    expect(confirmedCount(r.nextState)).toBe(13);
  });

  it("an OUT from the format's places says no \"a place opened\": there are no places", () => {
    const r = decide({ now: NOW, state: world({ confirmed: FOURTEEN, ...open }), messages: [selfOut("kemal")] });
    expect(r.speech.some((s) => s.kind === "slot_opened")).toBe(false);
    const before = decide({ now: NOW, state: world({ confirmed: FOURTEEN }), messages: [selfOut("kemal")] });
    expect(before.speech.some((s) => s.kind === "slot_opened")).toBe(true);
  });

  it("off: the same IN on a full squad goes to the bench, as before", () => {
    const state = world({ confirmed: FOURTEEN });
    const r = decide({ now: NOW, state, messages: [selfIn("youssef")] });
    expect(statusOf(r.nextState, "youssef")).toBe("BENCH");
  });
});
