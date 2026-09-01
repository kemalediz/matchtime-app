/**
 * INCIDENT CORPUS — pipeline #2 (router → extractors → engine → composer)
 * against the real model, in DRY RUN.
 *
 * §10 step 2's measurement. Same 46 cases, same adapter, same world
 * builder as `corpus-live.spec.ts` runs against the shipped analyzer, so
 * the two reports can be diffed case by case.
 *
 *   set -a; source .env; set +a
 *   npm run test:corpus:dryrun                        # 3 runs per case
 *   MT_SIM_RUNS=1 npm run test:corpus:dryrun          # one pass, cheap
 *   MT_CORPUS_FILTER=A5 npm run test:corpus:dryrun    # one case
 *
 * REPORTING, NOT GATING. The deliverable is the scoreboard and
 * `.e2e/corpus/report-live-dryrun.json`, which is what §10 step 3's two
 * criteria are read from: `spuriousWriteRuns` (target 0) and
 * `missedWriteRate` (target ≤2%). Set MT_CORPUS_MIN_PASS to turn it into
 * a gate once the pipeline is meant to hold a bar.
 *
 * NEVER weaken a corpus expectation to make this green.
 */
import path from "node:path";
import { test, expect, resetDb } from "../fixtures";
import { loadCorpus } from "../corpus/load";
import { DryRunPipeline } from "../corpus/dryrun-pipeline";
import { runCorpus, renderScoreboard, writeReport } from "../corpus/runner";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = Number(process.env.MT_SIM_RUNS ?? 3);
const FILTER = process.env.MT_CORPUS_FILTER;
const MIN_PASS = process.env.MT_CORPUS_MIN_PASS ? Number(process.env.MT_CORPUS_MIN_PASS) : null;

(LIVE ? test.describe : test.describe.skip)(
  "incident corpus LIVE — dry-run pipeline (router + extractors + engine)",
  () => {
    test.describe.configure({ mode: "default" });
    test.beforeAll(resetDb);

    test(`replays the whole corpus ×${RUNS} through the new pipeline`, async ({ request, db }) => {
      test.setTimeout(3 * 60 * 60_000);

      const cases = loadCorpus();
      const pipeline = new DryRunPipeline();
      let costUsd = 0;
      let batches = 0;

      const sb = await runCorpus({ request, db }, pipeline, cases, {
        mode: "live",
        runs: RUNS,
        ...(FILTER ? { filter: FILTER } : {}),
        onObservation: (c, o) => {
          const n = o.notes as
            | { costUsd?: number; routes?: unknown[]; degradations?: string[] }
            | undefined;
          if (typeof n?.costUsd === "number") {
            costUsd += n.costUsd;
            batches += 1;
          }
          // Triage: a filtered run prints the whole decision trail, so
          // "why did nothing happen?" is one command, not two logs
          // (§11.2 — debugging spans calls now, and this is the answer).
          if (FILTER) {
            // eslint-disable-next-line no-console
            console.log(
              `[corpus-dryrun] ${c.id}\n` +
                `  routes:  ${JSON.stringify(n?.routes)}\n` +
                `  before:  ${JSON.stringify(o.attendanceBefore)}\n` +
                `  after:   ${JSON.stringify(o.attendanceAfter)}\n` +
                `  spoken:  ${JSON.stringify(o.spoken)}\n` +
                `  reacts:  ${JSON.stringify(o.reacts)}  offers: ${o.benchOffersOpen}\n` +
                `  degrade: ${JSON.stringify(n?.degradations)}`,
            );
          }
        },
        onCase: (s) => {
          // eslint-disable-next-line no-console
          console.log(
            `[corpus-dryrun] ${s.passes}/${s.runs} ${s.caseId}` +
              (s.failures?.length ? `\n              ↳ ${s.failures.slice(0, 4).join(" | ")}` : ""),
          );
        },
      });

      // eslint-disable-next-line no-console
      console.log(renderScoreboard(sb));
      // eslint-disable-next-line no-console
      console.log(
        `[corpus-dryrun] measured cost: $${costUsd.toFixed(4)} over ${batches} batches ` +
          `= $${batches > 0 ? (costUsd / batches).toFixed(5) : "0"} per batch`,
      );

      const file = writeReport(
        {
          pipeline: pipeline.name,
          mode: "live",
          runsPerCase: RUNS,
          generatedAt: new Date().toISOString(),
          scoreboard: sb,
        },
        path.join(process.cwd(), ".e2e", "corpus", "report-live-dryrun.json"),
      );
      // eslint-disable-next-line no-console
      console.log(`[corpus-dryrun] machine-readable report → ${file}`);

      expect(sb.totals.runs, "the dry-run sweep produced no results at all").toBeGreaterThan(0);

      if (MIN_PASS !== null) {
        expect(
          sb.totals.runPassRate,
          `run pass rate ${(sb.totals.runPassRate * 100).toFixed(1)}% below the ` +
            `MT_CORPUS_MIN_PASS gate of ${(MIN_PASS * 100).toFixed(1)}%`,
        ).toBeGreaterThanOrEqual(MIN_PASS);
      }
    });
  },
);
