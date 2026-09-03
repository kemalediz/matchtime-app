/**
 * INCIDENT CORPUS — LIVE replay against the real Anthropic model.
 *
 * The measurement that matters. Every case is replayed through the real
 * `/api/whatsapp/analyze` route with no stub, WITH the chat-history
 * block the Pi sends in production, N times each because the model is
 * non-deterministic (MT_SIM_RUNS, following the convention of the other
 * `-live.spec.ts` files).
 *
 * Opt-in: only runs when MT_SIM_LIVE_LLM=1.
 *
 *   set -a; source .env; set +a
 *   npm run test:corpus:live                     # 3 runs per case
 *   MT_SIM_RUNS=5 npm run test:corpus:live       # 5
 *   MT_CORPUS_FILTER=S6 npm run test:corpus:live # one case
 *
 * REPORTING, NOT GATING, BY DEFAULT. §4 documents that today's prompt
 * does not reliably do what it says, so a live run is expected to show
 * failures; the deliverable is the scoreboard and the JSON report, which
 * is what §10 step 3's criteria are evaluated from. Set
 * MT_CORPUS_MIN_PASS=0.95 to turn it into a gate once a pipeline is
 * meant to hold a bar.
 *
 * NEVER weaken a corpus expectation to make this green. If a case fails,
 * check the expectation against the commit in its provenance block, then
 * record the failure.
 */
import path from "node:path";
import { test, expect, resetDb } from "../fixtures";
import { loadCorpus } from "../corpus/load";
import { CurrentAnalyzerPipeline } from "../corpus/current-analyzer-pipeline";
import { AttendanceEnginePipeline } from "../corpus/engine-pipeline";
import { runCorpus, renderScoreboard, writeReport } from "../corpus/runner";
import { describeReach, liveReachFailure, reachWatermark, readReach } from "../helpers/live-llm";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = Number(process.env.MT_SIM_RUNS ?? 3);
const FILTER = process.env.MT_CORPUS_FILTER;
const MIN_PASS = process.env.MT_CORPUS_MIN_PASS ? Number(process.env.MT_CORPUS_MIN_PASS) : null;

(LIVE ? test.describe : test.describe.skip)(
  "incident corpus LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "default" });
    test.beforeAll(resetDb);

    test(`replays the whole corpus ×${RUNS} and reports a scoreboard`, async ({ request, db }) => {
      // 45 cases × RUNS × one real batch call each. Budget generously.
      test.setTimeout(3 * 60 * 60_000);

      const cases = loadCorpus();
      // §10 step 6. `MT_CORPUS_ENGINE=1` runs the SAME 47 cases, the
      // same real model and the same worlds through the shipped route
      // with the attendance engine deciding and WRITING. Two runs of
      // this file, one with and one without, is the case-by-case
      // old-vs-new evidence the step is judged on — and because both
      // arms are the same spec, a difference cannot come from the
      // harness.
      const pipeline =
        process.env.MT_CORPUS_ENGINE === "1"
          ? new AttendanceEnginePipeline()
          : new CurrentAnalyzerPipeline();
      // Taken from the database's own clock, before a single case runs:
      // reach must be read from THIS sweep's rows, never from whatever
      // an earlier stubbed run left in the table.
      const since = await reachWatermark(db);

      const sb = await runCorpus({ request, db }, pipeline, cases, {
        mode: "live",
        runs: RUNS,
        ...(FILTER ? { filter: FILTER } : {}),
        onCase: (s) => {
          // eslint-disable-next-line no-console
          console.log(
            `[corpus-live] ${s.passes}/${s.runs} ${s.caseId}` +
              (s.failures?.length ? `\n              ↳ ${s.failures.slice(0, 4).join(" | ")}` : ""),
          );
        },
      });

      // ── was this actually live? ───────────────────────────────────
      // Read back off AnalyzedMessage.reasoning, which is where the
      // server already records how each verdict was reached. A sweep in
      // which the model was never asked scores whatever an all-silent
      // analyzer scores — 8/47, in four seconds — and reports it as a
      // measurement. It must fail instead. See helpers/live-llm.ts.
      const reach = await readReach(db, since);
      // eslint-disable-next-line no-console
      console.log(describeReach(reach));

      // eslint-disable-next-line no-console
      console.log(renderScoreboard(sb));
      const file = writeReport(
        {
          pipeline: pipeline.name,
          mode: "live",
          runsPerCase: RUNS,
          generatedAt: new Date().toISOString(),
          scoreboard: sb,
          reach,
        },
        // Named by PIPELINE as well as mode, so the two arms of the
        // step-6 A/B do not overwrite each other and can be diffed
        // case by case afterwards.
        path.join(process.cwd(), ".e2e", "corpus", `report-live-${pipeline.name}.json`),
      );
      // eslint-disable-next-line no-console
      console.log(`[corpus-live] machine-readable report → ${file}`);

      // The run itself must have produced data; a zero-case run means
      // the filter matched nothing or the harness broke.
      expect(sb.totals.runs, "the live run produced no results at all").toBeGreaterThan(0);

      // Asserted AFTER the scoreboard is printed and the report written,
      // so a failed sweep still leaves its evidence behind — but before
      // MT_CORPUS_MIN_PASS, because a pass rate from a sweep that never
      // reached the model is not a pass rate.
      const notLive = liveReachFailure(reach);
      expect(notLive ?? "", notLive ?? "").toBe("");

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
