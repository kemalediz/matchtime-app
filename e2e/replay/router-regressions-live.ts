/**
 * THE NAMED REGRESSIONS, LIVE — every message in `router-regressions.ts`
 * through the real router, N times, with the same live-or-refuse
 * guarantee the recall sweep has.
 *
 *   npm run replay:router-regressions
 *   MT_REGRESSION_REPEATS=5 npm run replay:router-regressions
 *
 * Exit code 1 when any `A` case routes `none` in any run. Nothing else
 * fails it — see the essay in `router-regressions.ts`.
 *
 * ⚠️ IT MUST REFUSE A KEYLESS RUN, for the reason `router-recall-live.ts`
 * spells out: `routeBatch` catches a failed call and routes the whole
 * batch `unsure`, which is an `A` owner, so a run with no key would
 * report every attendance case PASSING in about a second. That is the
 * same flattering silence as the keyless corpus sweep that scored 8/47.
 *
 * ONE MESSAGE PER CALL, deliberately. Real traffic averages 1.79
 * messages per batch, and the point of this file is to ask whether the
 * PROMPT handles a sentence — not whether a neighbouring message
 * happened to carry it. The full-corpus sweep is where real batching is
 * measured.
 */
import { config as loadEnv } from "dotenv";
import { probeAnthropic } from "../helpers/live-llm";
import { anthropicModel, ROUTER_MODEL } from "../../src/lib/pipeline/llm";
import { routeBatch } from "../../src/lib/pipeline/router";
import {
  ROUTER_REGRESSIONS,
  regressionsPass,
  renderRegressions,
  summariseRegressions,
  type RegressionOutcome,
} from "./router-regressions";
import type { Route } from "../../src/lib/pipeline/types";

loadEnv();

async function main(): Promise<number> {
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) {
    console.error(
      `[regress] REFUSING to run — ANTHROPIC_API_KEY is empty.\n` +
        `  routeBatch routes a failed call \`unsure\`, which satisfies every attendance\n` +
        `  case here, so a keyless run would pass in a second and prove nothing.\n` +
        `  Fix:  set -a; source .env; set +a`,
    );
    return 1;
  }

  const repeats = Math.max(1, Number(process.env.MT_REGRESSION_REPEATS ?? 3));
  const probe = await probeAnthropic({ key, model: ROUTER_MODEL });
  console.log(
    `[regress] LLM: LIVE — probe OK. ${probe.model} answered in ${probe.ms}ms and billed ` +
      `${probe.inputTokens} in / ${probe.outputTokens} out tokens to key ${probe.fingerprint}.`,
  );
  console.log(
    `[regress] ${ROUTER_REGRESSIONS.length} cases × ${repeats} runs, one message per call, ` +
      `floor OFF (the prompt is what is under test).`,
  );

  const model = anthropicModel({ apiKey: key });
  const outcomes: RegressionOutcome[] = ROUTER_REGRESSIONS.map((c) => ({ case: c, routes: [] }));
  let cost = 0;
  let calls = 0;
  let fallbacks = 0;

  for (let rep = 0; rep < repeats; rep++) {
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i]!;
      const res = await routeBatch(
        model,
        [{ id: `r${i}`, authorName: "Member", body: o.case.body }],
        { floor: false, awaiting: null },
      );
      if (res.usage) {
        calls += 1;
        cost += res.usage.costUsd ?? 0;
      }
      const row = res.routes[0]!;
      if (row.source === "fallback") fallbacks += 1;
      o.routes.push(row.route as Route);
    }
    console.log(`[regress]   run ${rep + 1}/${repeats} done · $${cost.toFixed(4)}`);
  }

  if (calls === 0 || fallbacks > 0) {
    console.error(
      `[regress] REFUSING to report — ${calls} billed calls and ${fallbacks} fallback routes. ` +
        `A fallback is \`unsure\`, which passes every attendance case for free.`,
    );
    return 1;
  }

  const report = summariseRegressions(outcomes);
  console.log("");
  console.log(renderRegressions(report));
  console.log("");
  console.log(
    `[regress] LIVE confirmed — ${calls} billed ${ROUTER_MODEL} calls, ` +
      `$${cost.toFixed(4)}, 0 fallbacks, key ${probe.fingerprint}.`,
  );
  return regressionsPass(report) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
