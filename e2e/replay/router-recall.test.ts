/**
 * The recall summariser. Pure, so these are cheap and exhaustive.
 *
 * The property that matters: a non-noise message routed `none` must
 * ALWAYS be counted as a miss and must never be quietly downgraded —
 * including when its intent is a label this module has never seen.
 */
import { describe, expect, it } from "vitest";
import {
  deriveFloorEffect,
  isBenignIntent,
  renderFloorEffect,
  renderRecall,
  severityOf,
  summariseRecall,
  wilson,
  type RoutedRow,
} from "./router-recall";

function row(over: Partial<RoutedRow>): RoutedRow {
  return {
    waMessageId: "m1",
    groupRef: "g-abc",
    body: "…",
    intent: "noise",
    handledBy: "llm",
    createdAt: "2026-05-01T18:00:00.000Z",
    route: "none",
    source: "model",
    ...over,
  };
}

describe("severity", () => {
  it("puts a squad place above everything else", () => {
    for (const i of ["in", "out", "conditional_in", "replacement_request", "team_swap"]) {
      expect(severityOf(i)).toBe("squad_place");
    }
  });

  it("treats an UNKNOWN intent as an action, never as benign", () => {
    // A label this file has never heard of must not be silently
    // downgraded to "safe" — that is how a real miss stops being
    // counted the day someone adds an intent.
    expect(severityOf("some_new_intent_2027")).toBe("action");
    expect(isBenignIntent("some_new_intent_2027")).toBe(false);
  });

  it("counts only the three the incumbent itself did nothing about as benign", () => {
    expect(isBenignIntent("noise")).toBe(true);
    expect(isBenignIntent("unclear")).toBe(true);
    expect(isBenignIntent("non-c.us author")).toBe(true);
    expect(isBenignIntent("question")).toBe(false);
    expect(isBenignIntent(null)).toBe(true);
  });
});

describe("summariseRecall", () => {
  it("separates the saving from the danger", () => {
    const r = summariseRecall([
      row({ intent: "noise", route: "none" }),
      row({ intent: "noise", route: "none" }),
      row({ intent: "noise", route: "self_att" }), // false positive
      row({ intent: "in", route: "self_att" }), // correct
      row({ intent: "in", route: "none" }), // THE MISS
    ]);
    expect(r.total).toBe(5);
    expect(r.benign).toBe(3);
    expect(r.nonBenign).toBe(2);
    expect(r.noneOnBenign).toBe(2);
    expect(r.falsePositives).toBe(1);
    expect(r.misses).toHaveLength(1);
    expect(r.misses[0].severity).toBe("squad_place");
    expect(r.missRate).toBe(0.5);
    expect(r.savingRate).toBeCloseTo(2 / 3);
  });

  it("orders misses worst-first, so a dropped IN is never buried", () => {
    const r = summariseRecall([
      row({ waMessageId: "q", intent: "question", route: "none" }),
      row({ waMessageId: "t", intent: "generate_teams_request", route: "none" }),
      row({ waMessageId: "i", intent: "in", route: "none" }),
    ]);
    expect(r.misses.map((m) => m.waMessageId)).toEqual(["i", "t", "q"]);
  });

  it("counts floor rescues separately from floor routes", () => {
    const r = summariseRecall([
      row({ intent: "in", route: "self_att", source: "floor" }),
      row({ intent: "noise", route: "none", source: "model" }),
    ]);
    expect(r.floorRoutes).toBe(1);
    expect(r.floorRescues).toBe(1);
  });

  it("reports an interval, because 0 of 40 is not 0%", () => {
    const r = summariseRecall(
      Array.from({ length: 40 }, () => row({ intent: "in", route: "self_att" })),
    );
    expect(r.missRate).toBe(0);
    expect(r.missRateCi95[0]).toBe(0);
    expect(r.missRateCi95[1]).toBeGreaterThan(0.05);
    expect(r.missRateCi95[1]).toBeLessThan(0.12);
  });

  it("an all-benign corpus has a 0% miss rate over a zero denominator, not a 0/0 NaN", () => {
    const r = summariseRecall([row({ intent: "noise", route: "none" })]);
    expect(r.missRate).toBe(0);
    expect(Number.isNaN(r.missRate)).toBe(false);
  });
});

describe("the report", () => {
  it("leads with the danger and lists EVERY miss", () => {
    const r = summariseRecall([
      row({ waMessageId: "i", intent: "in", route: "none", body: "im in" }),
      row({ intent: "noise", route: "none" }),
    ]);
    const text = renderRecall(r, { label: "test", costUsd: 0.01, ms: 1000, calls: 1, batches: 1 });
    expect(text.indexOf("THE DANGER")).toBeLessThan(text.indexOf("THE SAVING"));
    expect(text).toContain("im in");
    expect(text).toContain("intent=in");
    // And it never presents the incumbent as the answer key.
    expect(text).toContain("not truth");
  });

  it("says so plainly when nothing was missed", () => {
    const r = summariseRecall([row({ intent: "in", route: "self_att" })]);
    const text = renderRecall(r, { label: "test", costUsd: 0, ms: 0, calls: 1, batches: 1 });
    expect(text).toContain("Every non-noise message reached the analyzer");
  });
});

describe("deriveFloorEffect", () => {
  /** Stands in for `floorForcesAnalysis`: claims a bare "in" and
   *  nothing else, which is the real floor's defining shape. */
  const forces = (b: string) => /^in$/i.test(b.trim());

  it("rescues a miss the floor claims, and leaves the rest", () => {
    const rows = [
      row({ waMessageId: "a", intent: "in", body: "in", route: "none" }),
      row({ waMessageId: "b", intent: "in", body: "👍", route: "none" }),
      row({ waMessageId: "c", intent: "noise", body: "in", route: "none" }),
    ];
    const r = summariseRecall(rows);
    expect(r.misses).toHaveLength(2);
    const d = deriveFloorEffect(rows, r, forces);
    expect(d.rescuedMisses.map((m) => m.waMessageId)).toEqual(["a"]);
    expect(d.rescuedBenign).toBe(1);
    expect(d.missesAfter).toBe(1);
    expect(d.missRateAfter).toBe(0.5);
  });

  it("never rescues a message the router did NOT route `none`", () => {
    // The floor's only job in the gate is to un-skip. A message already
    // heading for the analyzer cannot be "rescued" into it.
    const rows = [row({ waMessageId: "a", intent: "in", body: "in", route: "self_att" })];
    const d = deriveFloorEffect(rows, summariseRecall(rows), forces);
    expect(d.rescued).toEqual([]);
    expect(d.rescuedBenign).toBe(0);
  });

  it("can only ever REDUCE the miss count — the monotonicity, at the corpus level", () => {
    const bodies = ["in", "out", "👍", "😂", "Shahrokh", "In ", "im in"];
    for (let seed = 0; seed < 30; seed++) {
      const rows = bodies.map((b, i) =>
        row({
          waMessageId: `m${i}`,
          body: b,
          intent: (i + seed) % 3 === 0 ? "in" : "noise",
          route: (i + seed) % 2 === 0 ? "none" : "self_att",
        }),
      );
      const r = summariseRecall(rows);
      const d = deriveFloorEffect(rows, r, forces);
      expect(d.missesAfter).toBeLessThanOrEqual(r.misses.length);
      expect(d.missRateAfter).toBeLessThanOrEqual(r.missRate);
    }
  });

  it("says plainly when the floor rescues nothing", () => {
    const rows = [row({ waMessageId: "b", intent: "in", body: "👍", route: "none" })];
    const r = summariseRecall(rows);
    expect(renderFloorEffect(deriveFloorEffect(rows, r, forces), r)).toContain(
      "rescues NONE of the misses",
    );
  });
});

describe("wilson", () => {
  it("never returns a point estimate for a rare event", () => {
    const [lo, hi] = wilson(0, 80);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0.04);
    expect(hi).toBeLessThan(0.05);
  });
});
