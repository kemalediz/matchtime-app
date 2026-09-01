/**
 * The sweep — replay every reconstructed batch through TWO pipelines and
 * diff them.
 *
 * Both pipelines go through `CorpusPipeline` (`e2e/corpus/pipeline.ts`),
 * the adapter PR #32 built for exactly this. There is deliberately no
 * second abstraction: a router + extractor + engine that never produces
 * a verdict implements the same interface as today's mega-prompt, so the
 * same batches judge both.
 *
 * Three properties make a long paid sweep trustworthy, and each is
 * unit-tested in `sweep.test.ts`:
 *
 *  · RESUMABLE — every completed unit is appended to a ledger keyed by
 *    the sweep's shape; a restart replays only what is missing.
 *  · HONEST ABOUT SAMPLING — a cap emits a plan naming every dropped
 *    key, and `partial` reaches the first line of the report.
 *  · SURVIVES ONE BAD CASE — a throw is recorded as an `error` unit and
 *    kept out of every denominator, and the sweep carries on.
 */
import path from "node:path";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "../corpus/pipeline";
import { diffRun, rollUpCriteria } from "./diff";
import type { Adjudication, CaseDiff, Criteria, RunOutcome } from "./diff";
import { Ledger, runIdOf, unitId, type LedgerEntry } from "./ledger";
import { planSample, type SamplingPlan } from "./sample";
import type { ReplayCase, ReplayTier } from "./types";

/** What a metering proxy reports for one span. See `meter.ts`. */
export interface MeteredSpan {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelMs: number;
  models: string[];
}

export interface CallMeter {
  begin(): void;
  end(): MeteredSpan;
}

export interface SweepOptions {
  mode?: CorpusMode;
  /** Repeats per case. Live models are non-deterministic; the self-
   *  replay noise floor is measured by repeating the SAME pipeline. */
  runs?: number;
  limit?: number | null;
  seed?: number;
  /** Directory the resume ledger lives in (default `.e2e/replay`). */
  ledgerDir?: string;
  /** Human verdicts on disagreements — see `diff.ts`. */
  adjudications?: Adjudication[];
  meter?: CallMeter;
  /** Keep errored units in the ledger so a resume does NOT retry them.
   *  Default false: a transient timeout should be retried on resume. */
  retainErrors?: boolean;
  onUnit?: (entry: LedgerEntry) => void;
  onCase?: (diff: CaseDiff, index: number, total: number) => void;
}

export interface PipelineCost {
  name: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Wall clock inside the pipeline, including DB set-up. */
  wallMs: number;
  batches: number;
}

export interface SweepResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  mode: CorpusMode;
  runsPerCase: number;
  pipelines: { old: string; new: string };
  plan: SamplingPlan;
  diffs: CaseDiff[];
  criteria: Criteria;
  /** The same criteria over strict-tier cases only. */
  criteriaStrict: Criteria;
  byTier: Record<ReplayTier, number>;
  cost: { old: PipelineCost; new: PipelineCost };
  /** Units served from the ledger rather than replayed. */
  resumedUnits: number;
  ledgerFile: string;
}

const ZERO_COST = (name: string): PipelineCost => ({
  name,
  calls: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  wallMs: 0,
  batches: 0,
});

function rosterOf(c: ReplayCase): string[] {
  return c.case.world.players.map((p) => p.name);
}

export async function runSweep(
  ctx: PipelineContext,
  oldPipeline: CorpusPipeline,
  newPipeline: CorpusPipeline,
  cases: ReplayCase[],
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const mode: CorpusMode = opts.mode ?? "live";
  const runs = Math.max(1, opts.runs ?? 1);
  const plan = planSample(cases, { limit: opts.limit ?? null, seed: opts.seed });
  const selected = plan.selected
    .map((k) => cases.find((c) => c.key === k))
    .filter((c): c is ReplayCase => !!c);

  const runId = runIdOf({
    pipelines: [oldPipeline.name, newPipeline.name],
    runs,
    caseKeys: plan.selected,
    mode,
  });
  const dir = opts.ledgerDir ?? path.join(process.cwd(), ".e2e", "replay");
  const ledger = new Ledger(path.join(dir, `${runId}.jsonl`));
  const done = ledger.load();

  const cost = { old: ZERO_COST(oldPipeline.name), new: ZERO_COST(newPipeline.name) };
  const byTier: Record<ReplayTier, number> = { strict: 0, wide: 0 };
  const diffs: CaseDiff[] = [];
  const startedAt = new Date().toISOString();
  let resumedUnits = 0;

  const replay = async (
    c: ReplayCase,
    pipeline: CorpusPipeline,
    run: number,
    bucket: PipelineCost,
  ): Promise<RunOutcome> => {
    const unit = unitId(c.key, pipeline.name, run);
    const cached = done.get(unit);
    if (cached) {
      resumedUnits += 1;
      bucket.wallMs += cached.ms ?? 0;
      bucket.costUsd += cached.costUsd ?? 0;
      bucket.batches += 1;
      return cached.ok && cached.observation
        ? { ok: true, observation: cached.observation }
        : { ok: false, error: cached.error ?? "unknown ledger error" };
    }

    const started = Date.now();
    opts.meter?.begin();
    let entry: LedgerEntry;
    let outcome: RunOutcome;
    try {
      const observation = await pipeline.run(ctx, c.case, mode);
      outcome = { ok: true, observation };
      entry = {
        unit,
        key: c.key,
        pipeline: pipeline.name,
        run,
        ok: true,
        observation,
        ms: Date.now() - started,
        at: new Date().toISOString(),
      };
    } catch (err) {
      // One malformed case must never take down three hours of model
      // calls. Record it and move on.
      outcome = { ok: false, error: (err as Error).message };
      entry = {
        unit,
        key: c.key,
        pipeline: pipeline.name,
        run,
        ok: false,
        error: (err as Error).message,
        ms: Date.now() - started,
        at: new Date().toISOString(),
      };
    }
    const span = opts.meter?.end();
    if (span) {
      entry.costUsd = span.costUsd;
      bucket.calls += span.calls;
      bucket.inputTokens += span.inputTokens;
      bucket.outputTokens += span.outputTokens;
      bucket.cacheReadTokens += span.cacheReadTokens;
      bucket.cacheWriteTokens += span.cacheWriteTokens;
      bucket.costUsd += span.costUsd;
    }
    bucket.wallMs += entry.ms ?? 0;
    bucket.batches += 1;
    if (entry.ok || opts.retainErrors) ledger.append(entry);
    opts.onUnit?.(entry);
    return outcome;
  };

  let index = 0;
  const total = selected.length * runs;
  for (const c of selected) {
    byTier[c.meta.tier] += 1;
    for (let run = 0; run < runs; run++) {
      // The OLD pipeline goes first on purpose: if the sweep is killed
      // mid-case the ledger holds the incumbent's half, which is the
      // half that is cheap to reproduce.
      const oldOutcome = await replay(c, oldPipeline, run, cost.old);
      const newOutcome = await replay(c, newPipeline, run, cost.new);
      const diff = diffRun(c.key, oldOutcome, newOutcome, rosterOf(c));
      diffs.push(diff);
      opts.onCase?.(diff, ++index, total);
    }
  }

  const adjudications = opts.adjudications ?? [];
  const strictKeys = new Set(selected.filter((c) => c.meta.tier === "strict").map((c) => c.key));

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    runsPerCase: runs,
    pipelines: { old: oldPipeline.name, new: newPipeline.name },
    plan,
    diffs,
    criteria: rollUpCriteria(diffs, adjudications),
    criteriaStrict: rollUpCriteria(
      diffs.filter((d) => strictKeys.has(d.key)),
      adjudications,
    ),
    byTier,
    cost,
    resumedUnits,
    ledgerFile: ledger.file,
  };
}
