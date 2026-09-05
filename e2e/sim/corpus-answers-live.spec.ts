/**
 * INCIDENT CORPUS — pipeline #4, §10 STEP 7's `question` and `balancer`
 * against the real model.
 *
 *   set -a; source .env; set +a
 *   npm run test:corpus:answers                      # 3 runs per case
 *   MT_SIM_RUNS=1 npm run test:corpus:answers        # one pass, cheap
 *   MT_CORPUS_FILTER=S19 npm run test:corpus:answers # one case, verbose
 *
 * The comparison is against `npm run test:corpus:live` (the incumbent)
 * on the SAME case ids. §10 step 7's blocker is stated in the branch
 * brief in one line: *any case the old path passes and this one fails*.
 * Both arms write a machine-readable report, so that comparison is a
 * diff and not a reading of two terminals.
 *
 * REPORTING, NOT GATING, like the other live sweeps — with two
 * exceptions that are about whether a measurement HAPPENED rather than
 * about whether it was good:
 *
 *   1. the sweep must have produced runs;
 *   2. it must have billed something. This pipeline is in-process and
 *      writes no `AnalyzedMessage` rows, so `liveReachFailure` has
 *      nothing to read; measured spend is the direct evidence that the
 *      router and the extractor were really called. PR #38's point was
 *      that a sweep which cannot reach the model must FAIL rather than
 *      score whatever an all-silent analyzer scores, and a $0.0000
 *      sweep here is exactly that shape. `e2e/run.ts`'s own
 *      `assertMeterSawTraffic` and `assertSeamMatchesMode` are the
 *      other two layers.
 *
 * NEVER weaken a corpus expectation to make this green.
 */
import path from "node:path";
import { test, expect, resetDb } from "../fixtures";
import { loadCorpus } from "../corpus/load";
import { AnswerEnginePipeline } from "../corpus/answer-engine-pipeline";
import { runCorpus, renderScoreboard, writeReport } from "../corpus/runner";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = Number(process.env.MT_SIM_RUNS ?? 3);
const FILTER = process.env.MT_CORPUS_FILTER;
const MIN_PASS = process.env.MT_CORPUS_MIN_PASS ? Number(process.env.MT_CORPUS_MIN_PASS) : null;

(LIVE ? test.describe : test.describe.skip)(
  "incident corpus LIVE — the answer engine (question + balancer)",
  () => {
    test.describe.configure({ mode: "default" });
    test.beforeAll(resetDb);

    test(`replays the owned cases ×${RUNS} through the answer engine`, async ({ request, db }) => {
      test.setTimeout(60 * 60_000);

      const cases = loadCorpus();
      const pipeline = new AnswerEnginePipeline();
      let costUsd = 0;
      let batches = 0;
      let handedBack = 0;
      let owned = 0;

      const sb = await runCorpus({ request, db }, pipeline, cases, {
        mode: "live",
        runs: RUNS,
        ...(FILTER ? { filter: FILTER } : {}),
        onObservation: (c, o) => {
          const n = o.notes as
            | {
                costUsd?: number;
                routes?: unknown[];
                owned?: string[];
                handedBack?: string[];
                reasons?: unknown[];
                degradations?: string[];
              }
            | undefined;
          if (typeof n?.costUsd === "number") {
            costUsd += n.costUsd;
            batches += 1;
          }
          owned += n?.owned?.length ?? 0;
          handedBack += n?.handedBack?.length ?? 0;
          if (FILTER) {
            console.log(
              `[corpus-answers] ${c.id}\n` +
                `  routes:      ${JSON.stringify(n?.routes)}\n` +
                `  owned:       ${JSON.stringify(n?.owned)}\n` +
                `  handed back: ${JSON.stringify(n?.handedBack)}\n` +
                `  reasons:     ${JSON.stringify(n?.reasons)}\n` +
                `  before:      ${JSON.stringify(o.attendanceBefore)}\n` +
                `  after:       ${JSON.stringify(o.attendanceAfter)}\n` +
                `  spoken:      ${JSON.stringify(o.spoken)}\n` +
                `  degrade:     ${JSON.stringify(n?.degradations)}`,
            );
          }
        },
        onCase: (s) => {
          if (s.skipped) return;
          console.log(
            `[corpus-answers] ${s.passes}/${s.runs} ${s.caseId}` +
              (s.failures?.length ? `\n              ↳ ${s.failures.slice(0, 4).join(" | ")}` : ""),
          );
        },
      });

      console.log(renderScoreboard(sb));
      console.log(
        `[corpus-answers] ${owned} message(s) owned, ${handedBack} handed back to the analyzer ` +
          `(a hand-back is a documented carve-out, not a failure).`,
      );
      console.log(
        `[corpus-answers] measured cost: $${costUsd.toFixed(4)} over ${batches} batches ` +
          `= $${batches > 0 ? (costUsd / batches).toFixed(5) : "0"} per batch ` +
          `(router + one extractor call).`,
      );

      const file = writeReport(
        {
          pipeline: pipeline.name,
          mode: "live",
          runsPerCase: RUNS,
          generatedAt: new Date().toISOString(),
          scoreboard: sb,
        },
        path.join(process.cwd(), ".e2e", "corpus", "report-live-answers.json"),
      );
      console.log(`[corpus-answers] machine-readable report → ${file}`);

      expect(sb.totals.runs, "the answer-engine sweep produced no results at all").toBeGreaterThan(
        0,
      );
      expect(
        costUsd,
        "the answer-engine sweep billed nothing, so it never reached the model — " +
          "the numbers above would be whatever an all-silent pipeline scores, " +
          "which is a fabricated measurement (PR #38).",
      ).toBeGreaterThan(0);

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
