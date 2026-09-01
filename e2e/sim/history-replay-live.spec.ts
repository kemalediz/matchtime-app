/**
 * The paid sweep — §10 step 3, without waiting two weeks.
 *
 *   npm run replay:extract                       # once, read-only, production
 *   MT_REPLAY_LIMIT=40 npm run test:replay:live  # self-replay noise floor
 *   MT_REPLAY_CANDIDATE=../pipeline/x.ts MT_REPLAY_LIMIT=40 npm run test:replay:live
 *
 * Env:
 *   MT_REPLAY_LIMIT      cap the number of batches (the report says so, loudly)
 *   MT_REPLAY_SEED       sampling seed (default 0)
 *   MT_REPLAY_RUNS       repeats per batch (default 1)
 *   MT_REPLAY_CANDIDATE  module exporting `default` = a CorpusPipeline class.
 *                        Omitted → SELF-REPLAY: the current analyzer against
 *                        itself, which measures the noise floor.
 *   MT_REPLAY_METER_PORT start the metering proxy on this port for measured cost
 *   MT_REPLAY_ADJUDICATIONS  path to a JSONL of human verdicts
 *   MT_REPLAY_FLOOR      path to an earlier self-replay's result.json, so a
 *                        candidate's rate is reported RELATIVE to the
 *                        incumbent's own noise floor rather than as an
 *                        absolute the incumbent itself could not meet
 *
 * ─────────────────────────────────────────────────────────────────────
 * VALIDATE BEFORE YOU TRUST
 * ─────────────────────────────────────────────────────────────────────
 * Run the SELF-REPLAY first. Every disagreement it finds is either model
 * non-determinism or a bug in this harness, never a pipeline difference.
 * A 3% disagreement rate between two pipelines means nothing if the same
 * pipeline disagrees with itself 3% of the time. That number is the one
 * every other number in the report has to clear.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { testDb } from "../helpers/test-db";
import { CurrentAnalyzerPipeline } from "../corpus/current-analyzer-pipeline";
import type { CorpusPipeline } from "../corpus/pipeline";
import type { Adjudication } from "../replay/diff";
import { summariseFloor, type FloorSummary } from "../replay/floor";
import { AnthropicMeter, NULL_METER } from "../replay/meter";
import { renderReport, renderTriage } from "../replay/report";
import { runSweep } from "../replay/sweep";
import type { ReconstructionStats, ReplayCase } from "../replay/types";
import { describeReach, liveReachFailure, readReach } from "../helpers/live-llm";

const OUT = path.join(process.cwd(), ".e2e", "replay");
const CASES_FILE = path.join(OUT, "cases.json");

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
}

function loadAdjudications(): Adjudication[] {
  const file = process.env.MT_REPLAY_ADJUDICATIONS ?? path.join(OUT, "adjudications.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Adjudication);
}

test.describe("history replay sweep", () => {
  test("replays production history through two pipelines and diffs them", async ({ request }) => {
    test.skip(
      !existsSync(CASES_FILE),
      `no ${CASES_FILE} — run \`npm run replay:extract\` first (read-only against production)`,
    );
    test.skip(
      process.env.MT_SIM_LIVE_LLM !== "1",
      "live-only: run via `npm run test:replay:live`",
    );
    // A sweep is minutes-to-hours by design. It is resumable, so a
    // timeout is an interruption, not a lost run.
    test.setTimeout(num("MT_REPLAY_TIMEOUT_MS", 6 * 60 * 60 * 1000));

    const { cases, stats } = JSON.parse(readFileSync(CASES_FILE, "utf8")) as {
      cases: ReplayCase[];
      stats: ReconstructionStats;
    };

    const oldPipeline: CorpusPipeline = new CurrentAnalyzerPipeline();
    let newPipeline: CorpusPipeline;
    const candidate = process.env.MT_REPLAY_CANDIDATE;
    if (candidate) {
      const mod = (await import(candidate)) as { default: new () => CorpusPipeline };
      newPipeline = new mod.default();
    } else {
      // SELF-REPLAY. A distinct name would make the report claim a
      // comparison it is not making, so the name stays identical and
      // the report switches into noise-floor framing.
      newPipeline = new CurrentAnalyzerPipeline();
    }

    let meter = NULL_METER;
    let proxy: AnthropicMeter | null = null;
    if (process.env.MT_REPLAY_METER_PORT) {
      proxy = new AnthropicMeter();
      await proxy.listen(Number(process.env.MT_REPLAY_METER_PORT));
      meter = proxy;
    }

    const db = testDb();
    const started = Date.now();
    // A candidate comparison is only meaningful against the incumbent's
    // own floor: §10 step 3's "≤2%" is not an absolute if the current
    // analyzer cannot reproduce its own writes.
    let priorFloor: FloorSummary | undefined;
    if (process.env.MT_REPLAY_FLOOR && existsSync(process.env.MT_REPLAY_FLOOR)) {
      const prior = JSON.parse(readFileSync(process.env.MT_REPLAY_FLOOR, "utf8")) as {
        result: { diffs: Parameters<typeof summariseFloor>[0] };
      };
      priorFloor = summariseFloor(prior.result.diffs, cases);
    }

    const result = await runSweep({ request, db }, oldPipeline, newPipeline, cases, {
      mode: "live",
      runs: num("MT_REPLAY_RUNS", 1),
      limit: process.env.MT_REPLAY_LIMIT ? num("MT_REPLAY_LIMIT", 0) : null,
      seed: num("MT_REPLAY_SEED", 0),
      ledgerDir: OUT,
      adjudications: loadAdjudications(),
      meter,
      onCase: (d, i, total) => {
        const mins = ((Date.now() - started) / 60_000).toFixed(1);
        console.log(
          `[replay] ${i}/${total} ${d.key} ${d.agree ? "agree" : (d.primary ?? "?")} (${mins}m)`,
        );
      },
    });

    await proxy?.close();

    // Was this actually live? The noise floor is now a load-bearing
    // number — every candidate pipeline is judged relative to it — and a
    // keyless sweep produces the most flattering floor imaginable: two
    // all-silent pipelines agree with each other perfectly, 0%
    // disagreement, green tick. Same hole as the corpus sweep, same
    // read-back off AnalyzedMessage.reasoning. See helpers/live-llm.ts.
    const reach = await readReach(db);
    console.log(describeReach(reach));

    const dir = path.join(OUT, result.runId);
    mkdirSync(dir, { recursive: true });
    const selected = cases.filter((c) => result.plan.selected.includes(c.key));
    const report = renderReport(result, stats, loadAdjudications(), selected, priorFloor);
    const floor = summariseFloor(result.diffs, selected);
    writeFileSync(path.join(dir, "report.txt"), `${report}\n`);
    writeFileSync(path.join(dir, "triage.md"), renderTriage(result.diffs, selected));
    writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(
        { result, floor, reach, reconstruction: stats, meteredCalls: proxy?.all ?? [] },
        null,
        2,
      ),
    );
    console.log(report);
    console.log(`\nwrote ${dir}/report.txt, triage.md, result.json`);

    // The sweep MEASURES; it does not gate. The only things asserted are
    // that it measured something — a green tick on an empty sweep is
    // exactly the failure mode §10 step 3 warns about — and that what it
    // measured was the model rather than an offline fallback.
    expect(result.diffs.length, "the sweep replayed nothing").toBeGreaterThan(0);
    expect(result.criteria.runs + result.criteria.errors).toBe(result.diffs.length);
    const notLive = liveReachFailure(reach);
    expect(notLive ?? "", notLive ?? "").toBe("");
  });
});
