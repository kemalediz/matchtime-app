/**
 * The corpus RUNNER — feeds cases to any pipeline and scores them.
 *
 * Reports a scoreboard, not just pass/fail: per case, per §3.2 section
 * and per A–E category, plus the two numbers §10 step 3 fixes in advance
 * as the go/no-go for the redesign ("zero cases where the new pipeline
 * would write and the old correctly did not; ≤2% missed writes").
 *
 * The JSON report is written to `.e2e/corpus/` (gitignored) so a run's
 * result can be diffed between pipelines without anyone re-reading a
 * terminal.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildScoreboard,
  gradeCase,
  renderScoreboard,
  type CaseRunSummary,
  type CorpusCase,
  type CorpusObservation,
  type Scoreboard,
} from "./grade";
import type { CorpusMode, CorpusPipeline, PipelineContext } from "./pipeline";
import type { ReachSummary } from "../helpers/live-llm";

export interface RunOptions {
  mode: CorpusMode;
  /** Replays per case. Live models are non-deterministic, so live runs
   *  repeat, following the convention of the existing `-live.spec.ts`
   *  files (MT_SIM_RUNS, default 5). */
  runs?: number;
  /** Substring filter on the case id, for triaging one case. */
  filter?: string;
  /** Called after every case so a long live run reports as it goes. */
  onCase?: (summary: CaseRunSummary) => void;
  /** Called with every raw observation. Triage aid — never asserted. */
  onObservation?: (c: CorpusCase, o: CorpusObservation) => void;
}

export async function runCorpus(
  ctx: PipelineContext,
  pipeline: CorpusPipeline,
  cases: CorpusCase[],
  opts: RunOptions,
): Promise<Scoreboard> {
  const runs = Math.max(1, opts.runs ?? 1);
  const results: CaseRunSummary[] = [];

  for (const c of cases) {
    if (opts.filter && !c.id.includes(opts.filter)) continue;

    const summary: CaseRunSummary = {
      caseId: c.id,
      sections: c.sections,
      category: c.category,
      runs: 0,
      passes: 0,
      classifications: [],
      failures: [],
    };

    if (!pipeline.supports(c, opts.mode)) {
      summary.skipped = true;
      results.push(summary);
      opts.onCase?.(summary);
      continue;
    }

    for (let i = 0; i < runs; i++) {
      summary.runs += 1;
      // A case that throws is recorded and the run carries on. One bad
      // case took down a whole live sweep 12 cases in; three hours of
      // model calls should never hinge on one malformed fixture.
      let grade;
      try {
        const observation = await pipeline.run(ctx, c, opts.mode);
        opts.onObservation?.(c, observation);
        grade = gradeCase(c, observation);
      } catch (err) {
        summary.classifications.push("error");
        const msg = `harness error: ${(err as Error).message}`;
        if (!summary.failures!.includes(msg)) summary.failures!.push(msg);
        continue;
      }
      if (grade.passed) {
        summary.passes += 1;
      } else {
        if (grade.classification) summary.classifications.push(grade.classification);
        for (const f of grade.failures) {
          if (!summary.failures!.includes(f)) summary.failures!.push(f);
        }
      }
    }
    results.push(summary);
    opts.onCase?.(summary);
  }

  return buildScoreboard(results);
}

export interface CorpusReport {
  pipeline: string;
  mode: CorpusMode;
  runsPerCase: number;
  generatedAt: string;
  scoreboard: Scoreboard;
  /** LIVE runs only: how many of the sweep's messages actually reached
   *  the model. A scoreboard without this is not evidence that anything
   *  was measured — see e2e/helpers/live-llm.ts. */
  reach?: ReachSummary;
}

export function writeReport(
  report: CorpusReport,
  file = path.join(process.cwd(), ".e2e", "corpus", `report-${report.mode}.json`),
): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export { renderScoreboard };
