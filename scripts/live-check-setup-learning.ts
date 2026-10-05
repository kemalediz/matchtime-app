/**
 * F3, LEARNED SETUP: THE ONE LIVE CHECK (2026-10-05). NOT RUN YET.
 *
 * A new prompt, so per CLAUDE.md it needs Kemal's approval for ONE live
 * check before SETUP_LEARNING_ENABLED is switched on. The unit tests stub
 * the model; they prove the wiring and the rules, not that Haiku reads a
 * real chat the way the fixtures expect. This does: each fixture ONCE,
 * through the exact prompt, schema, parser and planner production uses.
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
 * refuses without it; stops at MAX_USD. Touches no database, sends
 * nothing, writes nothing. Reports the number of model calls, the tokens
 * and the cost, and for each fixture what was detected against what the
 * fixture expects, the plan, and the DM it would send.
 */
import { readFileSync } from "node:fs";
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
  type Detection,
  type OrgSettingsState,
} from "../src/lib/setup-learning/rules.ts";
import { composeSetupDm } from "../src/lib/setup-learning/dm.ts";
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
  expect: Record<string, unknown> & { applied: string[]; noted: string[]; suggestions: string[]; dm: boolean; skipped?: string };
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

/** The detection fields a fixture pins, as "field: expected / got". */
function grade(fx: Fixture, d: Detection): string[] {
  const misses: string[] = [];
  const e = fx.expect;
  const check = (label: string, want: unknown, got: unknown) => {
    if (want !== undefined && JSON.stringify(want) !== JSON.stringify(got)) {
      misses.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  };
  check("regularGame", e.regularGame, d.regularGame);
  check("squad", e.squad, d.squad.answer);
  check("openPlaces", e.openPlaces, d.openPlaces.answer);
  check("payments", e.payments, d.payments.answer);
  check("monthlyList", e.monthlyList, d.monthlyList.answer);
  if (e.dropOutDeadline) check("dropOutDeadline", e.dropOutDeadline, { day: d.dropOutDeadline.day, time: d.dropOutDeadline.time });
  if (e.listPublished) check("listPublished", e.listPublished, { day: d.listPublished.day, time: d.listPublished.time });
  return misses;
}

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
      continue;
    }
    const plan = planSetup({
      detection,
      org: { ...DEFAULTS, language: fx.language },
      weeklyGame: fx.weeklyGame,
      activities: [{ dayOfWeek: fx.weeklyGame.dayOfWeek, time: fx.weeklyGame.time }],
      chatLanguage: detectGroupLang({ subject: fx.groupSubject, history: fx.history.map((m) => m.text) }),
    });
    const misses = grade(fx, detection);
    const keys = (xs: Array<{ key: string }>) => xs.map((x) => x.key);
    if (JSON.stringify(keys(plan.applied)) !== JSON.stringify(fx.expect.applied)) {
      misses.push(`applied: expected ${JSON.stringify(fx.expect.applied)}, got ${JSON.stringify(keys(plan.applied))}`);
    }
    if (JSON.stringify(keys(plan.noted)) !== JSON.stringify(fx.expect.noted)) {
      misses.push(`noted: expected ${JSON.stringify(fx.expect.noted)}, got ${JSON.stringify(keys(plan.noted))}`);
    }
    if (JSON.stringify(keys(plan.suggestions)) !== JSON.stringify(fx.expect.suggestions)) {
      misses.push(`suggestions: expected ${JSON.stringify(fx.expect.suggestions)}, got ${JSON.stringify(keys(plan.suggestions))}`);
    }
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
      });
      console.log(`  DM:\n${dm.replace(/^/gm, "    | ")}`);
    } else {
      console.log("  DM: none");
    }
    console.log(misses.length === 0 ? "  PASS" : `  FAIL\n    ${misses.join("\n    ")}`);
    if (misses.length > 0) failures.push(name);
  }

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
