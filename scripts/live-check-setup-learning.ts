/**
 * F3, LEARNED SETUP: THE LIVE CHECK. EVERY RUN NEEDS KEMAL'S APPROVAL.
 *
 *   Run 1, 2026-10-05: 6 calls, $0.0437, 3 of 6 fixtures FAILED (rolling,
 *     turkish, monthly-list). Haiku said "high" on single remarks, wrote
 *     its own summary as evidence, and read a monthly-list group as a
 *     rolling squad. The prompt was rewritten and `rules.ts` now needs two
 *     quotes from two messages, and switches nothing for a monthly list.
 *   Run 2, 2026-10-06: 6 calls, $0.0475, 5 of 6 pass. "rolling" FAILED:
 *     open_places = organisers_pick at "high" on two real quotes from two
 *     messages (an organiser sorting ONE replacement), so the two-quote
 *     guard let it be switched. Fixed downstream of the model, prompt
 *     untouched: who fills an open place is never switched, it is
 *     suggested (rules.ts, rule 4). That run's six raw answers are kept in
 *     src/lib/setup-learning/__fixtures__/live-check-run-2.json and
 *     replayed offline by __tests__/live-replay.test.ts: all six pass, so
 *     no third paid run was needed for this change.
 *
 * A new or rewritten prompt needs ONE approved live check before
 * SETUP_LEARNING_ENABLED is switched on. The unit tests stub the model;
 * they prove the wiring and the rules, not that Haiku reads a real chat
 * the way the fixtures expect. This does: each fixture ONCE, through the
 * exact prompt, schema, parser and planner production uses.
 *
 *   # Free: what the run WOULD send and cost, no model call.
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-setup-learning.ts --estimate
 *
 *   # The approved run (asks the real model, spends ANTHROPIC_API_KEY_DEV):
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-setup-learning.ts --approved
 *
 *   # One fixture only:
 *   ONLY=monthly-list node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-setup-learning.ts --approved
 *
 * Six fixtures make a call (rolling, organiser-picks, deadlines, first-come,
 * turkish, monthly-list); empty and too-short are gated before the model
 * and make none, which the run also shows. Spends the DEV key only and
 * refuses without it; stops at MAX_USD. Touches no database and sends
 * nothing. Reports the number of model calls, the tokens and the cost,
 * and for each fixture the raw answer, every answer after the quote check
 * (so a dropped quote is visible), the plan, what was left alone and why,
 * and the DM it would send, against what the fixture expects.
 *
 * The whole run is also SAVED as JSON (raw answers included) to OUT, or
 * to a file in the temp directory whose path is printed at the end: run
 * 1's raw output was not kept, and a failure cannot be traced without it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, costOf, estimateTokens, extractJson } from "../src/lib/pipeline/llm.ts";
import {
  SETUP_LEARNING_MAX_TOKENS,
  SETUP_LEARNING_MODEL,
  SETUP_LEARNING_SCHEMA,
  SETUP_LEARNING_SYSTEM_PROMPT,
} from "../src/lib/setup-learning/prompt.ts";
import {
  buildUserContent,
  historyGate,
  parseDetection,
  planIsWorthTelling,
  planSetup,
  type OrgSettingsState,
} from "../src/lib/setup-learning/rules.ts";
import { composeSetupDm } from "../src/lib/setup-learning/dm.ts";
import { gradeFixture, type FixtureExpect } from "../src/lib/setup-learning/__tests__/grade.ts";
import { detectGroupLang } from "../src/lib/i18n/detect.ts";
import type { HistoryMessage } from "../src/lib/onboarding-enrichment-reconcile.ts";

const FIXTURES = ["rolling", "organiser-picks", "deadlines", "first-come", "turkish", "monthly-list", "empty", "too-short"];
const MAX_USD = 0.25;
/** Output tokens assumed by the estimate (the schema's answer is ~300 to 600). */
const EST_OUTPUT_TOKENS = 700;

interface Fixture {
  name: string;
  groupSubject: string;
  language: string;
  weeklyGame: { dayOfWeek: number; time: string; venue: string; playersPerSide: number };
  expect: FixtureExpect;
  history: HistoryMessage[];
}

function load(name: string): Fixture {
  const file = path.join(__dirname, "..", "src", "lib", "setup-learning", "__fixtures__", `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Fixture;
}

const DEFAULTS: OrgSettingsState = {
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
  paymentTrackingEnabled: false,
  language: "en",
  settingsSetByOrganiser: [],
};

async function main() {
  const estimateOnly = process.argv.includes("--estimate");
  const approved = process.argv.includes("--approved");
  const only = process.env.ONLY?.trim();
  const names = only ? FIXTURES.filter((n) => n === only) : FIXTURES;

  const systemTokens = estimateTokens(SETUP_LEARNING_SYSTEM_PROMPT);
  console.log(
    `Prompt: ${SETUP_LEARNING_SYSTEM_PROMPT.length} chars, ~${systemTokens} tokens (estimate), model ${SETUP_LEARNING_MODEL}, not cached.`,
  );

  // ── The estimate (free) ───────────────────────────────────────────────
  let estUsd = 0;
  let estCalls = 0;
  for (const name of names) {
    const fx = load(name);
    const gate = historyGate(fx.history);
    if (!gate.ok) {
      console.log(`  ${name.padEnd(16)} no call (${gate.reason})`);
      continue;
    }
    const user = buildUserContent({ groupSubject: fx.groupSubject, weeklyGame: fx.weeklyGame, history: fx.history });
    // Haiku runs about 3.8 to 5 chars per token (pipeline/llm.ts); /3.5 errs high.
    const inTok = Math.ceil((SETUP_LEARNING_SYSTEM_PROMPT.length + user.text.length) / 3.5);
    const usd = costOf(SETUP_LEARNING_MODEL, { inputTokens: inTok, outputTokens: EST_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 }) ?? 0;
    estUsd += usd;
    estCalls++;
    console.log(`  ${name.padEnd(16)} 1 call, ~${inTok} input tokens, <= ${EST_OUTPUT_TOKENS} output: ~$${usd.toFixed(4)}`);
  }
  console.log(`Estimate: ${estCalls} model calls, ~$${estUsd.toFixed(4)} in total (cap $${MAX_USD}).`);
  if (estimateOnly) return;
  if (!approved) {
    console.error("\nRefusing to call the model without --approved (Kemal's approval for this run, CLAUDE.md).\n");
    process.exit(1);
  }

  // ── The live run ─────────────────────────────────────────────────────
  spendDevApiKeyOrExit("live-check-setup-learning");
  const model = anthropicModel();
  let calls = 0;
  let spent = 0;
  let inTotal = 0;
  let outTotal = 0;
  const failures: string[] = [];
  const record: Array<Record<string, unknown>> = [];

  for (const name of names) {
    const fx = load(name);
    console.log(`\n━━ ${name} ━━`);
    const gate = historyGate(fx.history);
    if (!gate.ok) {
      const ok = fx.expect.skipped === gate.reason;
      console.log(`  gated: ${gate.reason}, no call. ${ok ? "PASS" : "FAIL"}`);
      if (!ok) failures.push(name);
      continue;
    }
    if (spent >= MAX_USD) {
      console.log(`  stopped: $${spent.toFixed(4)} spent, cap $${MAX_USD}`);
      break;
    }
    const user = buildUserContent({ groupSubject: fx.groupSubject, weeklyGame: fx.weeklyGame, history: fx.history });
    calls++;
    const resp = await model.complete({
      model: SETUP_LEARNING_MODEL,
      system: SETUP_LEARNING_SYSTEM_PROMPT,
      user: user.text,
      maxTokens: SETUP_LEARNING_MAX_TOKENS,
      schema: SETUP_LEARNING_SCHEMA as unknown as Record<string, unknown>,
      label: "setup-learning-live-check",
    });
    spent += resp.costUsd ?? 0;
    inTotal += resp.usage.inputTokens;
    outTotal += resp.usage.outputTokens;
    console.log(`  ${resp.usage.inputTokens} in / ${resp.usage.outputTokens} out, $${(resp.costUsd ?? 0).toFixed(4)}, ${resp.ms} ms`);
    console.log(`  raw: ${resp.text}`);
    const detection = parseDetection(extractJson(resp.text), fx.history);
    if (!detection) {
      console.log("  FAIL: not an object");
      failures.push(name);
      record.push({ fixture: name, raw: resp.text, misses: ["not an object"] });
      continue;
    }
    // Every answer AFTER the quote check: what the planner really saw.
    const checked = {
      squad: detection.squad,
      openPlaces: detection.openPlaces,
      dropOutDeadline: detection.dropOutDeadline,
      listPublished: detection.listPublished,
      payments: detection.payments,
      monthlyList: detection.monthlyList,
      weeklyGame: detection.weeklyGame,
    };
    for (const [k, v] of Object.entries(checked)) console.log(`  checked ${k}: ${JSON.stringify(v)}`);
    const plan = planSetup({
      detection,
      org: { ...DEFAULTS, language: fx.language },
      weeklyGame: fx.weeklyGame,
      activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
      chatLanguage: detectGroupLang({ subject: fx.groupSubject, history: fx.history.map((m) => m.text) }),
    });
    // The same grader the offline replay uses (__tests__/live-replay.test.ts).
    const misses = gradeFixture(fx.expect, detection, plan);
    console.log(`  plan: applied ${JSON.stringify(plan.applied.map((a) => [a.key, a.to, a.evidence]))}`);
    console.log(`        kept ${JSON.stringify(plan.kept)}, suggestions ${JSON.stringify(plan.suggestions)}, noted ${JSON.stringify(plan.noted)}`);
    if (planIsWorthTelling(plan)) {
      const dm = composeSetupDm({
        lang: fx.language,
        group: fx.groupSubject,
        applied: plan.applied.map((a) => ({ ...a, undoUrl: `https://matchtime.ai/r/undo-${a.key}` })),
        suggestions: plan.suggestions,
        noted: plan.noted,
        scheduleUrl: "https://matchtime.ai/r/schedule",
        settingsUrl: "https://matchtime.ai/r/settings",
        organiserPicksUrl: "https://matchtime.ai/r/pick",
      });
      console.log(`  DM:\n${dm.replace(/^/gm, "    | ")}`);
    } else {
      console.log("  DM: none");
    }
    console.log(misses.length === 0 ? "  PASS" : `  FAIL\n    ${misses.join("\n    ")}`);
    if (misses.length > 0) failures.push(name);
    record.push({ fixture: name, usage: resp.usage, costUsd: resp.costUsd, raw: resp.text, checked, plan, expect: fx.expect, misses });
  }

  const out = process.env.OUT?.trim() || path.join(os.tmpdir(), `live-check-setup-learning-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ model: SETUP_LEARNING_MODEL, calls, spent, inTotal, outTotal, failures, fixtures: record }, null, 2));
  console.log(`\nSaved (raw answers included): ${out}`);

  console.log(
    `\nModel calls: ${calls}. Tokens: ${inTotal} in, ${outTotal} out. Cost: $${spent.toFixed(4)}.` +
      ` ${failures.length === 0 ? "All fixtures pass." : `Failed: ${failures.join(", ")}.`}`,
  );
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
