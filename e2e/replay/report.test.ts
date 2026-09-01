/**
 * The report, under test. Two things it must never do: let a partial
 * run read as complete, and let an unadjudicated sweep read as a pass.
 */
import { describe, expect, it } from "vitest";
import { renderReport, renderTriage } from "./report";
import type { CaseDiff } from "./diff";
import type { SweepResult } from "./sweep";
import type { ReconstructionStats, ReplayCase } from "./types";

const stats: ReconstructionStats = {
  messagesInSource: 1723,
  messagesReplayable: 469,
  messagesExcluded: 1254,
  batchesInSource: 700,
  batchesReplayable: 300,
  batchesExcluded: 400,
  byTier: { strict: 250, wide: 50 },
  byReason: {
    "attendance-state-unknown": { batches: 380, messages: 1200 },
  } as ReconstructionStats["byReason"],
  intentDistribution: { noise: 361, in: 40 },
  intentDistributionAll: { noise: 1194, in: 245 },
};

const agreed: CaseDiff = {
  key: "k1",
  agree: true,
  classes: [],
  primary: null,
  writesOld: { attendance: [], newMembers: [], benchOffersDelta: 0, score: null, teams: [] },
  writesNew: { attendance: [], newMembers: [], benchOffersDelta: 0, score: null, teams: [] },
  onlyOld: [],
  onlyNew: [],
  conflicting: [],
  speechOld: { spoke: false, posts: 0, dms: 0, reacted: false, namesMentioned: [], claimsMismatch: [], rawPhone: false },
  speechNew: { spoke: false, posts: 0, dms: 0, reacted: false, namesMentioned: [], claimsMismatch: [], rawPhone: false },
  spokenOld: [],
  spokenNew: [],
  errors: {},
};

const spurious: CaseDiff = {
  ...agreed,
  key: "k2",
  agree: false,
  classes: ["spurious_write"],
  primary: "spurious_write",
  onlyNew: [{ name: "Gina Gale", from: "ABSENT", to: "CONFIRMED" }],
  spokenNew: ["Gina you're in"],
};

function result(over: Partial<SweepResult> = {}): SweepResult {
  const base: SweepResult = {
    runId: "abc123",
    startedAt: "2026-09-01T10:00:00.000Z",
    finishedAt: "2026-09-01T10:30:00.000Z",
    mode: "live",
    runsPerCase: 1,
    pipelines: { old: "current-analyzer", new: "current-analyzer" },
    plan: {
      total: 300,
      selected: ["k1", "k2"],
      excludedKeys: [],
      strategy: "all",
      seed: 0,
      limit: null,
      strata: { noise: { available: 1, selected: 1 }, in: { available: 1, selected: 1 } },
      partial: false,
    },
    diffs: [agreed, spurious],
    criteria: {
      runs: 2,
      errors: 0,
      disagreements: 1,
      spuriousWriteRuns: 0,
      spuriousWriteUnadjudicated: 1,
      missedWriteRuns: 0,
      missedWriteUnadjudicated: 0,
      missedWriteRate: 0,
      missedWriteRateCeiling: 0,
      divergentWriteRuns: 0,
      speechOnlyRuns: 0,
      newPipelineBetter: 0,
      bothWrong: 0,
      bothRight: 0,
      passesStep3: null,
    },
    criteriaStrict: {
      runs: 2,
      errors: 0,
      disagreements: 1,
      spuriousWriteRuns: 0,
      spuriousWriteUnadjudicated: 1,
      missedWriteRuns: 0,
      missedWriteUnadjudicated: 0,
      missedWriteRate: 0,
      missedWriteRateCeiling: 0,
      divergentWriteRuns: 0,
      speechOnlyRuns: 0,
      newPipelineBetter: 0,
      bothWrong: 0,
      bothRight: 0,
      passesStep3: null,
    },
    byTier: { strict: 2, wide: 0 },
    cost: {
      old: { name: "current-analyzer", calls: 2, costUsd: 0.06, inputTokens: 500, outputTokens: 1400, cacheReadTokens: 36000, cacheWriteTokens: 4000, wallMs: 20000, batches: 2 },
      new: { name: "current-analyzer", calls: 2, costUsd: 0.06, inputTokens: 500, outputTokens: 1400, cacheReadTokens: 36000, cacheWriteTokens: 4000, wallMs: 20000, batches: 2 },
    },
    resumedUnits: 0,
    ledgerFile: "/tmp/x.jsonl",
  };
  return { ...base, ...over };
}

describe("renderReport", () => {
  it("leads with the self-replay noise floor when both pipelines are the same one", () => {
    const out = renderReport(result(), stats, []);
    expect(out).toContain("SELF-REPLAY NOISE FLOOR");
    // Every disagreement in a self-replay is either model non-determinism
    // or a harness bug — the number every other number is read against.
    expect(out).toMatch(/noise floor.*50\.0%|50\.0%.*noise floor/is);
  });

  it("shouts when the run was capped, and says what it dropped", () => {
    const out = renderReport(
      result({
        plan: { ...result().plan, partial: true, limit: 2, excludedKeys: ["k9", "k10"], strategy: "stratified" },
      }),
      stats,
      [],
    );
    expect(out).toContain("PARTIAL RUN");
    expect(out).toContain("2 of 300");
    expect(out).toContain("298 batches were NOT replayed");
  });

  it("reports step 3 as UNDECIDED while disagreements are unadjudicated", () => {
    const out = renderReport(result({ pipelines: { old: "current", new: "candidate" } }), stats, []);
    expect(out).toContain("UNDECIDED");
    expect(out).not.toMatch(/step 3:\s*PASS/i);
  });

  it("states replayability with its reasons rather than a bare percentage", () => {
    const out = renderReport(result(), stats, []);
    expect(out).toContain("469 of 1723");
    expect(out).toContain("attendance-state-unknown");
  });
});

describe("renderTriage", () => {
  const c: ReplayCase = {
    key: "k2",
    meta: {
      batchKey: "k2",
      orgId: "org-1",
      groupRef: "g-abc",
      at: "2026-05-12T18:30:00.000Z",
      tier: "wide",
      assumptions: ["config assumed stable"],
      caveats: ["completed match omitted"],
      hoursToKickoff: 2.5,
      maxPlayers: 14,
      squadBefore: { confirmed: 13, bench: 0, dropped: 1 },
      prodOutcomes: [{ waMessageId: "wa1", intent: "in", action: "registered", handledBy: "llm" }],
      unresolvedSenders: [],
    },
    case: {
      id: "k2",
      title: "t",
      sections: [],
      category: "A",
      provenance: { kind: "production", note: "n" },
      world: { players: [{ key: "p0", name: "Gina Gale" }] },
      messages: [{ from: { name: "Gina Gale", phone: "" }, body: "can I play" }],
      expect: {},
    },
  };

  it("gives a human everything needed to say which pipeline was right", () => {
    const out = renderTriage([spurious], [c]);
    expect(out).toContain("can I play");
    expect(out).toContain("13 confirmed");
    expect(out).toContain("2.5h to kickoff");
    expect(out).toContain("completed match omitted");
    // Production's own label is offered as a hint, explicitly not truth.
    expect(out).toContain("not ground truth");
    // And a line to fill in.
    expect(out).toContain("old_right");
  });

  it("says nothing when the two pipelines agreed", () => {
    expect(renderTriage([agreed], [c])).toContain("no disagreements");
  });
});
