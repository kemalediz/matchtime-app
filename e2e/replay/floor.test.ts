/**
 * The noise floor, under test.
 *
 * The coordinator's point, and it reframes the whole exercise: §10 step
 * 3's "≤2% missed writes" is meaningless as an ABSOLUTE if the incumbent
 * cannot reproduce its own writes. A candidate scoring 1% against a 2%
 * incumbent floor is BETTER, not a regression — and if the floor's
 * confidence interval straddles the target, the criterion cannot
 * discriminate at all and saying so is the finding.
 */
import { describe, expect, it } from "vitest";
import {
  compareToFloor,
  discriminates,
  runsForHalfWidth,
  summariseFloor,
  wilson,
} from "./floor";
import type { CaseDiff, DisagreementClass } from "./diff";
import type { ReplayCase } from "./types";

function diff(key: string, classes: DisagreementClass[]): CaseDiff {
  const empty = { attendance: [], newMembers: [], benchOffersDelta: 0, score: null, teams: [] };
  const speech = {
    spoke: false, posts: 0, dms: 0, reacted: false,
    namesMentioned: [], claimsMismatch: [], rawPhone: false,
  };
  return {
    key,
    agree: classes.length === 0,
    classes,
    primary: classes[0] ?? null,
    writesOld: empty,
    writesNew: empty,
    onlyOld: [],
    onlyNew: [],
    conflicting: [],
    speechOld: speech,
    speechNew: speech,
    spokenOld: [],
    spokenNew: [],
    errors: {},
  };
}

function rcase(key: string, intent: string): ReplayCase {
  return {
    key,
    meta: {
      batchKey: key, orgId: "o", groupRef: "g", at: "2026-05-12T18:30:00.000Z",
      tier: "strict", assumptions: [], caveats: [], hoursToKickoff: 2, maxPlayers: 14,
      squadBefore: { confirmed: 0, bench: 0, dropped: 0 },
      prodOutcomes: [{ waMessageId: "m-1", intent, action: null, handledBy: "llm" }],
      unresolvedSenders: [],
    },
    case: {
      id: key, title: key, sections: [], category: "A",
      provenance: { kind: "production", note: "n" },
      world: { players: [] }, messages: [], expect: {},
    },
  };
}

describe("wilson", () => {
  it("never returns a negative lower bound on zero events", () => {
    const [lo, hi] = wilson(0, 80);
    expect(lo).toBe(0);
    // 0/80 is NOT proof of 0% — the interval still reaches ~4.6%.
    expect(hi).toBeGreaterThan(0.03);
    expect(hi).toBeLessThan(0.06);
  });

  it("tightens as the sample grows", () => {
    const small = wilson(2, 40);
    const large = wilson(20, 400);
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
  });

  it("is empty and honest with no runs at all", () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe("summariseFloor", () => {
  const cases = [
    rcase("k1", "in"),
    rcase("k2", "conditional_in"),
    rcase("k3", "conditional_in"),
    rcase("k4", "noise"),
  ];
  const diffs = [
    diff("k1", []),
    diff("k2", ["divergent_write"]),
    diff("k3", ["divergent_write"]),
    diff("k4", ["speech_only"]),
  ];

  it("separates chattiness from a player being in or out on luck", () => {
    const f = summariseFloor(diffs, cases);
    const by = Object.fromEntries(f.byClass.map((c) => [c.cls, c]));
    expect(by.speech_only.count).toBe(1);
    expect(by.divergent_write.count).toBe(2);
    // The one that matters: writes, not wording.
    expect(f.writeLevel.count).toBe(2);
    expect(f.writeLevel.rate).toBeCloseTo(0.5, 5);
  });

  it("says WHERE the write-level noise clusters, not just how much", () => {
    const f = summariseFloor(diffs, cases);
    // Both divergent writes are conditional_in. That is a named defect,
    // not background noise.
    expect(f.writeClustersByIntent).toEqual({ conditional_in: 2 });
    expect(f.writeClusterConcentration).toBeCloseTo(1, 5);
  });

  it("carries an interval on every rate, because a rare event on 80 runs is not a point", () => {
    const f = summariseFloor(diffs, cases);
    expect(f.writeLevel.ci95[0]).toBeLessThan(f.writeLevel.rate);
    expect(f.writeLevel.ci95[1]).toBeGreaterThan(f.writeLevel.rate);
  });
});

describe("the criteria are relative to the floor", () => {
  /** Well-powered: 800 replays, 2.5% divergent. */
  const floor = { cls: "divergent_write" as const, count: 20, runs: 800, rate: 0.025, ci95: wilson(20, 800) };
  /** What 80 replays actually buys: the same 2.5%, a useless interval. */
  const thin = { cls: "divergent_write" as const, count: 2, runs: 80, rate: 0.025, ci95: wilson(2, 80) };

  it("calls a candidate below the incumbent's floor BETTER, not a regression", () => {
    expect(compareToFloor(0.01, floor)).toBe("better");
  });

  it("calls a candidate inside the interval indistinguishable", () => {
    expect(compareToFloor(0.03, floor)).toBe("indistinguishable");
  });

  it("refuses to call the SAME comparison better on a thin sample", () => {
    // 2/80 and 20/800 are both 2.5%, but only one of them can support a
    // claim. Reporting "better" off 80 replays would be inventing
    // resolution the sweep did not buy.
    expect(compareToFloor(0.01, thin)).toBe("indistinguishable");
  });

  it("calls a candidate above the interval worse", () => {
    expect(compareToFloor(0.4, floor)).toBe("worse");
  });

  it("says plainly when a floor is too high for the ≤2% bar to mean anything", () => {
    // The bar can only discriminate if the incumbent's own floor is
    // credibly BELOW it.
    expect(discriminates(wilson(2, 80), 0.02)).toBe(false);
    expect(discriminates(wilson(0, 400), 0.02)).toBe(true);
  });
});

describe("runsForHalfWidth", () => {
  it("says how many replays a usable interval would need", () => {
    const n = runsForHalfWidth(0.025, 0.01);
    expect(n).toBeGreaterThan(500);
    expect(runsForHalfWidth(0.025, 0.02)).toBeLessThan(n);
  });
});
