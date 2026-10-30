/**
 * Which team change the players' group makes from the teams extractor's
 * `swap` facts (2026-10-30). Pure: the shape is read from the FACTS the
 * model returned, never from the message's words.
 */
import { describe, it, expect } from "vitest";
import { playersSwapShape } from "../team-swap-apply";

const facts = (over: Partial<Parameters<typeof playersSwapShape>[0]> = {}) => ({ swaps: [], moves: [], pairings: [], swapSides: false, ...over });

describe("playersSwapShape", () => {
  it("the two whole teams swapping over", () => {
    expect(playersSwapShape(facts({ swapSides: true }))).toEqual({ kind: "swap-sides" });
  });

  it("two people changing team is a two-player swap, in the order read", () => {
    expect(playersSwapShape(facts({ moves: ["Elvin", "Raihan"] }))).toEqual({ kind: "two-players", a: "Elvin", b: "Raihan" });
    expect(playersSwapShape(facts({ moves: ["me", " Can "] }))).toEqual({ kind: "two-players", a: "me", b: "Can" });
  });

  it("anything else is not supported in the players' group", () => {
    expect(playersSwapShape(facts({ moves: ["Tom"] })).kind).toBe("unsupported");
    expect(playersSwapShape(facts({ moves: ["A", "B", "C"] })).kind).toBe("unsupported");
    expect(playersSwapShape(facts({ swaps: [{ personRef: "David", team: "RED" }] })).kind).toBe("unsupported");
    expect(playersSwapShape(facts({ pairings: [["Ali", "Habib"]] })).kind).toBe("unsupported");
    expect(playersSwapShape(facts({ moves: ["A", "B"], pairings: [["C", "D"]] })).kind).toBe("unsupported");
    expect(playersSwapShape(facts()).kind).toBe("unsupported");
  });
});
