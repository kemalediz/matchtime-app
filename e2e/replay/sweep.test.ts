/**
 * The sweep driver, under test — sampling, resumability, classification.
 *
 * A 1,723-message live sweep is long and expensive. Three properties
 * decide whether it is trustworthy, and all three are pinned here:
 *
 *  1. A seeded pair of pipelines with KNOWN disagreements is classified
 *     the way §10 step 3 needs.
 *  2. It RESUMES. The corpus harness learned this the hard way when one
 *     bad fixture killed a paid sweep 12 cases in.
 *  3. A capped run can never read as a complete one.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CorpusObservation } from "../corpus/grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "../corpus/pipeline";
import { Ledger, runIdOf } from "./ledger";
import { planSample } from "./sample";
import { runSweep } from "./sweep";
import type { ReplayCase } from "./types";

const CTX = {} as PipelineContext;

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "mt-replay-"));
}

function replayCase(key: string, intent: string, players: string[] = ["Pete Power"]): ReplayCase {
  return {
    key,
    meta: {
      batchKey: key,
      orgId: "org-1",
      groupRef: "g-abc",
      at: "2026-05-12T18:30:00.000Z",
      tier: "strict",
      assumptions: [],
      caveats: [],
      hoursToKickoff: 2,
      maxPlayers: 14,
      squadBefore: { confirmed: 1, bench: 0, dropped: 0 },
      prodOutcomes: [{ waMessageId: `wa-${key}`, intent, action: null, handledBy: "llm" }],
      unresolvedSenders: [],
    },
    case: {
      id: key,
      title: key,
      sections: [],
      category: "A",
      provenance: { kind: "production", note: "test" },
      world: { players: players.map((name, i) => ({ key: `p${i}`, name })) },
      messages: [{ from: { name: "Pete Power", phone: "" }, body: "in" }],
      expect: {},
    },
  };
}

const BASE: CorpusObservation = {
  attendanceBefore: [{ name: "Pete Power", status: "CONFIRMED" }],
  attendanceAfter: [{ name: "Pete Power", status: "CONFIRMED" }],
  memberNamesBefore: ["Pete Power"],
  memberNamesAfter: ["Pete Power"],
  spoken: [],
  dms: [],
  reacts: [null],
  benchOffersOpen: 0,
};

const WROTE: CorpusObservation = {
  ...BASE,
  attendanceAfter: [
    { name: "Pete Power", status: "CONFIRMED" },
    { name: "Gina Gale", status: "CONFIRMED" },
  ],
  memberNamesAfter: ["Pete Power", "Gina Gale"],
};

/** A pipeline whose behaviour per case is scripted. */
class ScriptedPipeline implements CorpusPipeline {
  calls: string[] = [];
  constructor(
    readonly name: string,
    private readonly script: Record<string, CorpusObservation | Error>,
    private readonly fallback: CorpusObservation = BASE,
  ) {}
  supports(): boolean {
    return true;
  }
  async run(_ctx: PipelineContext, c: { id: string }, _mode: CorpusMode): Promise<CorpusObservation> {
    this.calls.push(c.id);
    const scripted = this.script[c.id];
    if (scripted instanceof Error) throw scripted;
    return scripted ?? this.fallback;
  }
}

describe("planSample — a capped run can never read as complete", () => {
  const cases = [
    replayCase("k1", "noise"),
    replayCase("k2", "noise"),
    replayCase("k3", "in"),
    replayCase("k4", "question"),
  ];

  it("selects everything and says so when uncapped", () => {
    const p = planSample(cases, {});
    expect(p.partial).toBe(false);
    expect(p.selected).toHaveLength(4);
    expect(p.excludedKeys).toEqual([]);
    expect(p.strategy).toBe("all");
  });

  it("names what it dropped, and how it chose", () => {
    const p = planSample(cases, { limit: 2, seed: 7 });
    expect(p.partial).toBe(true);
    expect(p.selected).toHaveLength(2);
    expect(p.excludedKeys).toHaveLength(2);
    expect([...p.selected, ...p.excludedKeys].sort()).toEqual(["k1", "k2", "k3", "k4"]);
    expect(p.strategy).toBe("stratified");
    expect(p.seed).toBe(7);
  });

  it("spreads a cap across production's intent mix instead of taking the first N", () => {
    // Taking the head would give two `noise` batches and tell us nothing
    // about the 31% of traffic that is not noise.
    const p = planSample(cases, { limit: 3, seed: 1 });
    const strata = p.selected.map((k) => cases.find((c) => c.key === k)!.meta.prodOutcomes[0].intent);
    expect(new Set(strata).size).toBeGreaterThan(1);
    for (const [label, s] of Object.entries(p.strata)) {
      expect(s.selected).toBeLessThanOrEqual(s.available);
      expect(label).toBeTruthy();
    }
  });

  it("is deterministic for a given seed", () => {
    expect(planSample(cases, { limit: 2, seed: 42 }).selected).toEqual(
      planSample(cases, { limit: 2, seed: 42 }).selected,
    );
  });
});

describe("Ledger — a paid sweep must never restart from zero", () => {
  it("round-trips entries", () => {
    const file = path.join(tmp(), "ledger.jsonl");
    const l = new Ledger(file);
    l.append({ unit: "k1|old|0", key: "k1", pipeline: "old", run: 0, ok: true, observation: BASE, ms: 12, at: "x" });
    expect([...new Ledger(file).load().keys()]).toEqual(["k1|old|0"]);
  });

  it("skips a corrupt line instead of taking down the sweep", () => {
    const file = path.join(tmp(), "ledger.jsonl");
    const l = new Ledger(file);
    l.append({ unit: "k1|old|0", key: "k1", pipeline: "old", run: 0, ok: true, observation: BASE, ms: 1, at: "x" });
    writeFileSync(file, readFileSync(file, "utf8") + '{"unit":"broken\n');
    l.append({ unit: "k2|old|0", key: "k2", pipeline: "old", run: 0, ok: true, observation: BASE, ms: 1, at: "x" });
    expect([...new Ledger(file).load().keys()]).toEqual(["k1|old|0", "k2|old|0"]);
  });

  it("gives a different run id when the sweep's shape changes", () => {
    const a = runIdOf({ pipelines: ["old", "new"], runs: 1, caseKeys: ["k1"], mode: "live" });
    expect(runIdOf({ pipelines: ["old", "new"], runs: 1, caseKeys: ["k1"], mode: "live" })).toBe(a);
    expect(runIdOf({ pipelines: ["old", "new"], runs: 2, caseKeys: ["k1"], mode: "live" })).not.toBe(a);
    expect(runIdOf({ pipelines: ["old", "new"], runs: 1, caseKeys: ["k2"], mode: "live" })).not.toBe(a);
  });
});

describe("runSweep — classification", () => {
  const cases = [replayCase("agree", "in"), replayCase("spurious", "noise"), replayCase("missed", "in")];

  const oldPipe = () => new ScriptedPipeline("old", { missed: WROTE });
  const newPipe = () => new ScriptedPipeline("new", { spurious: WROTE });

  it("classifies a seeded pair of pipelines exactly the way §10 step 3 asks", async () => {
    const r = await runSweep(CTX, oldPipe(), newPipe(), cases, { ledgerDir: tmp() });
    const byKey = Object.fromEntries(r.diffs.map((d) => [d.key, d.primary]));
    expect(byKey).toEqual({ agree: null, spurious: "spurious_write", missed: "missed_write" });
    expect(r.criteria.disagreements).toBe(2);
    // Nobody has adjudicated, so neither counts yet and step 3 is
    // UNDECIDED — never a quiet pass.
    expect(r.criteria.spuriousWriteUnadjudicated).toBe(1);
    expect(r.criteria.missedWriteUnadjudicated).toBe(1);
    expect(r.criteria.passesStep3).toBeNull();
  });

  it("records a thrown case and carries on with the rest", async () => {
    const boom = new ScriptedPipeline("old", { spurious: new Error("kaboom") });
    const r = await runSweep(CTX, boom, newPipe(), cases, { ledgerDir: tmp() });
    expect(r.diffs).toHaveLength(3);
    expect(r.diffs.find((d) => d.key === "spurious")!.primary).toBe("error");
    expect(r.criteria.errors).toBe(1);
    expect(r.criteria.runs).toBe(2);
  });

  it("reports the sampling plan alongside the numbers", async () => {
    const r = await runSweep(CTX, oldPipe(), newPipe(), cases, { ledgerDir: tmp(), limit: 2, seed: 3 });
    expect(r.plan.partial).toBe(true);
    expect(r.diffs).toHaveLength(2);
    expect(r.plan.excludedKeys).toHaveLength(1);
  });
});

describe("runSweep — resumability", () => {
  it("does not re-run a unit the ledger already holds", async () => {
    const dir = tmp();
    const cases = [replayCase("k1", "in"), replayCase("k2", "in")];

    const first = new ScriptedPipeline("old", {});
    const firstNew = new ScriptedPipeline("new", {});
    const a = await runSweep(CTX, first, firstNew, cases, { ledgerDir: dir });
    expect(first.calls).toEqual(["k1", "k2"]);
    expect(a.resumedUnits).toBe(0);

    // Same sweep, same ledger dir: everything is already known.
    const second = new ScriptedPipeline("old", {});
    const secondNew = new ScriptedPipeline("new", {});
    const b = await runSweep(CTX, second, secondNew, cases, { ledgerDir: dir });
    expect(second.calls).toEqual([]);
    expect(secondNew.calls).toEqual([]);
    expect(b.resumedUnits).toBe(4);
    expect(b.diffs.map((d) => d.primary)).toEqual(a.diffs.map((d) => d.primary));
  });

  it("resumes a sweep that died half way and completes only the rest", async () => {
    const dir = tmp();
    const cases = [replayCase("k1", "in"), replayCase("k2", "in"), replayCase("k3", "in")];

    // First attempt dies on k2.
    const dying = new ScriptedPipeline("old", { k2: new Error("connection reset") });
    await runSweep(CTX, dying, new ScriptedPipeline("new", {}), cases, { ledgerDir: dir, retainErrors: false });

    const resumed = new ScriptedPipeline("old", {});
    const r = await runSweep(CTX, resumed, new ScriptedPipeline("new", {}), cases, { ledgerDir: dir });
    // k1 and k3 came from the ledger; only the failed unit was redone.
    expect(resumed.calls).toEqual(["k2"]);
    expect(r.diffs.every((d) => d.primary === null)).toBe(true);
  });

  it("starts a fresh ledger when the sweep's shape changes", async () => {
    const dir = tmp();
    const cases = [replayCase("k1", "in")];
    await runSweep(CTX, new ScriptedPipeline("old", {}), new ScriptedPipeline("new", {}), cases, { ledgerDir: dir });

    const again = new ScriptedPipeline("old", {});
    const r = await runSweep(CTX, again, new ScriptedPipeline("new", {}), cases, { ledgerDir: dir, runs: 2 });
    expect(again.calls).toEqual(["k1", "k1"]); // new runId → nothing to resume
    expect(r.resumedUnits).toBe(0);
  });
});
