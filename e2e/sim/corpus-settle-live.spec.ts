/**
 * SETTLE ONE CORPUS CASE — many live runs, and the model's own reasoning
 * captured for every one of them.
 *
 * `corpus-live.spec.ts` replays all 47 cases a handful of times each. It
 * answers "how is the corpus doing"; it cannot answer "is this 34/36 vs
 * 33/33 a regression or noise", because 36 runs of a ~95% event has a
 * ±7pp interval and because it throws the reasoning away.
 *
 * This spec answers exactly that question, for exactly one case:
 *
 *   MT_CORPUS_FILTER=S12 MT_SIM_RUNS=100 MT_SETTLE_LABEL=after-36 \
 *     npm run test:corpus:settle
 *
 * It records, per run: pass/fail, every `AnalyzedMessage` row the run
 * wrote (body, intent, handledBy and the model's free-text reasoning),
 * and what `outSafetyNetSignals` makes of that reasoning. The last part
 * is the point. When a case that a deterministic backstop is supposed to
 * catch fails anyway, the interesting question is not the p-value, it is
 * WHICH SIGNAL DID NOT FIRE — and that is only answerable if the
 * reasoning that reached the guard was kept.
 *
 * Output: `.e2e/corpus/settle-<label>.json` plus a printed summary with
 * a Wilson interval and, from `e2e/replay/floor.ts`'s own arithmetic,
 * how many runs a tighter interval would need.
 *
 * REPORTS, NEVER GATES. Like the live corpus sweep, it asserts only that
 * it really measured something. `MT_SETTLE_MIN_PASS` turns it into a gate.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, resetDb } from "../fixtures";
import { loadCorpus } from "../corpus/load";
import { CurrentAnalyzerPipeline } from "../corpus/current-analyzer-pipeline";
import { gradeCase, type CorpusCase } from "../corpus/grade";
import { describeReach, liveReachFailure, reachWatermark, readReach } from "../helpers/live-llm";
import { runsForHalfWidth, wilson } from "../replay/floor";
import { outSafetyNetSignals } from "../../src/lib/out-safety-net";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const FILTER = process.env.MT_CORPUS_FILTER ?? "";
const RUNS = Number(process.env.MT_SIM_RUNS ?? 100);
const LABEL = process.env.MT_SETTLE_LABEL ?? FILTER ?? "settle";
const MIN_PASS = process.env.MT_SETTLE_MIN_PASS ? Number(process.env.MT_SETTLE_MIN_PASS) : null;

interface AnalyzedRow {
  body: string | null;
  handledBy: string | null;
  intent: string | null;
  reasoning: string | null;
}

interface RunRecord {
  run: number;
  passed: boolean;
  failures: string[];
  classification: string | null;
  messages: Array<
    AnalyzedRow & {
      backstop: { strongDrop: boolean; notDropping: boolean; forceOut: boolean };
    }
  >;
}

(LIVE ? test.describe : test.describe.skip)("settle one corpus case (real model)", () => {
  test.describe.configure({ mode: "default" });
  test.beforeAll(resetDb);

  test(`replays MT_CORPUS_FILTER ×${RUNS} and keeps every reasoning`, async ({ request, db }) => {
    test.skip(!FILTER, "set MT_CORPUS_FILTER to the case id to settle");
    test.setTimeout(6 * 60 * 60_000);

    const matches = loadCorpus().filter((c) => c.id.includes(FILTER));
    expect(matches.length, `MT_CORPUS_FILTER=${FILTER} matched ${matches.length} cases; want 1`).toBe(
      1,
    );
    const c: CorpusCase = matches[0];
    const pipeline = new CurrentAnalyzerPipeline();
    const since = await reachWatermark(db);

    const records: RunRecord[] = [];
    for (let i = 1; i <= RUNS; i++) {
      const observation = await pipeline.run({ request, db }, c, "live");
      const grade = gradeCase(c, observation);
      const orgId = (observation.notes?.orgId as string) ?? "";
      const rows = await db.all<AnalyzedRow>(
        `SELECT body, "handledBy", intent, reasoning FROM "AnalyzedMessage"
          WHERE "orgId" = $1 ORDER BY "createdAt" ASC`,
        [orgId],
      );
      records.push({
        run: i,
        passed: grade.passed,
        failures: grade.failures,
        classification: grade.classification ?? null,
        messages: rows.map((r) => ({ ...r, backstop: outSafetyNetSignals(r.reasoning) })),
      });
      const passes = records.filter((r) => r.passed).length;
      // eslint-disable-next-line no-console
      console.log(
        `[settle:${LABEL}] ${i}/${RUNS} ${grade.passed ? "pass" : "FAIL"} ` +
          `(${passes}/${i})` +
          (grade.passed ? "" : `\n              ↳ ${grade.failures.slice(0, 3).join(" | ")}`),
      );
    }

    const passes = records.filter((r) => r.passed).length;
    const rate = passes / RUNS;
    const ci = wilson(passes, RUNS);
    const reach = await readReach(db, since);

    const lines: string[] = [];
    lines.push(`══ SETTLE ${c.id} — ${LABEL} ══════════════════════════════`);
    lines.push(`  ${passes}/${RUNS} passed (${(rate * 100).toFixed(1)}%)`);
    lines.push(
      `  Wilson 95%: [${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]  ` +
        `(±${(((ci[1] - ci[0]) / 2) * 100).toFixed(1)}pp)`,
    );
    lines.push(
      `  runs for ±5pp at this rate: ${runsForHalfWidth(rate, 0.05)}; ` +
        `for ±2pp: ${runsForHalfWidth(rate, 0.02)}   (e2e/replay/floor.ts)`,
    );
    lines.push(`  ${describeReach(reach)}`);

    // The backstop analysis. For every FAILING run, what did the model
    // actually say, and what did `outSafetyNetSignals` make of it?
    const failing = records.filter((r) => !r.passed);
    lines.push(`\n  failing runs: ${failing.length}`);
    for (const f of failing) {
      lines.push(`  ── run ${f.run} (${f.classification ?? "?"}) ──`);
      for (const fail of f.failures) lines.push(`     ✗ ${fail}`);
      for (const m of f.messages) {
        lines.push(`     msg  "${(m.body ?? "").slice(0, 90)}"`);
        lines.push(`     by   handledBy=${m.handledBy} intent=${m.intent}`);
        lines.push(`     why  ${(m.reasoning ?? "(none)").slice(0, 600)}`);
        lines.push(
          `     net  strongDrop=${m.backstop.strongDrop} ` +
            `notDropping=${m.backstop.notDropping} forceOut=${m.backstop.forceOut}`,
        );
      }
    }

    // The same signals across the PASSING runs, so a fired-vs-not-fired
    // comparison has a control group rather than an anecdote.
    const tally = { strongDrop: 0, notDropping: 0, forceOut: 0, total: 0 };
    for (const r of records) {
      for (const m of r.messages) {
        tally.total += 1;
        if (m.backstop.strongDrop) tally.strongDrop += 1;
        if (m.backstop.notDropping) tally.notDropping += 1;
        if (m.backstop.forceOut) tally.forceOut += 1;
      }
    }
    lines.push(
      `\n  backstop across all ${tally.total} analyzed messages: ` +
        `strongDrop ${tally.strongDrop}, notDropping ${tally.notDropping}, forceOut ${tally.forceOut}`,
    );
    lines.push("═".repeat(62));
    const summary = lines.join("\n");
    // eslint-disable-next-line no-console
    console.log(summary);

    const dir = path.join(process.cwd(), ".e2e", "corpus");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `settle-${LABEL}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          caseId: c.id,
          label: LABEL,
          runs: RUNS,
          passes,
          rate,
          wilson95: ci,
          reach,
          generatedAt: new Date().toISOString(),
          records,
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console
    console.log(`[settle:${LABEL}] machine-readable → ${file}`);

    const notLive = liveReachFailure(reach);
    expect(notLive ?? "", notLive ?? "").toBe("");
    if (MIN_PASS !== null) expect(rate).toBeGreaterThanOrEqual(MIN_PASS);
  });
});
