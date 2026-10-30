/**
 * LIVE CHECK FOR P1 OF THE "NO STRING PARSING" SWEEP (2026-10-30).
 *
 * ⚠️ THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only
 * (ANTHROPIC_API_KEY_DEV); it refuses without it and stops at MAX_USD.
 *
 * Each case is a behaviour a regex used to decide and the model decides
 * now, run ONCE (Kemal's cheap plan):
 *   - the router: the bot named without an @ (to_bot), bare IN/OUT and
 *     "@Name IN" with no floor, the "who do you mean?" reply, the
 *     "which team won?" answer and a score correction shown as facts;
 *   - the attendance extractor: a joking drop (low confidence), unnamed
 *     and whole-group references (personNamed false);
 *   - the score extractor: an answer to "which team won?" and chatter;
 *   - the admin extractor: the reminder time as a London date and time;
 *   - the question extractor: a clarification reply read against the
 *     original question.
 *
 *   npx tsx scripts/live-check-no-parsing-p1.ts
 */
import { config as loadEnv } from "dotenv";
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch, type RouterMessage } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import type { Route } from "../src/lib/pipeline/types.ts";
import type { StatsClarification } from "../src/lib/pipeline/awaiting-answer.ts";

loadEnv({ quiet: true });
const MAX_USD = 0.2;
spendDevApiKeyOrExit("the P1 no-parsing live check");

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

// Tue 20 Oct 2026, 19:00 London (BST); the clocks go back on Sun 25 Oct.
const NOW = new Date("2026-10-20T18:00:00Z");
const results: Array<{ id: string; pass: boolean; got: string; want: string }> = [];
const record = (id: string, pass: boolean, got: unknown, want: string) => {
  results.push({ id, pass, got: JSON.stringify(got), want });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: got ${JSON.stringify(got)}; want ${want}`);
};

const CLAR: StatsClarification = {
  id: "am-1",
  orgId: "org",
  askerUserId: "u-kemal",
  askerName: "Kemal Ediz",
  questionBody: "@Match Time Zork's chemistry",
  askedAt: new Date(NOW.getTime() - 5 * 60_000),
};

interface RouterCase {
  id: string;
  msg: Omit<RouterMessage, "id">;
  want: Route[];
  toBot?: boolean;
  opts?: { clar?: boolean; scoreAnswer?: boolean; correction?: boolean };
}

const ROUTER_CASES: RouterCase[] = [
  { id: "B1-name-no-at", msg: { authorName: "Ali", body: "MatchTime who runs this club?" }, want: ["question"], toBot: true },
  { id: "B1-about-the-bot", msg: { authorName: "Kemal", body: "please do not forget to rate the players via the link from Matchtime DM'ed to you" }, want: ["none"], toBot: false },
  { id: "B1-tagged", msg: { authorName: "Ali", body: "@Match Time who's in?" }, want: ["question"], toBot: true },
  { id: "F-bare-in", msg: { authorName: "Pete", body: "in" }, want: ["self_att"] },
  { id: "F-bare-IN-emoji", msg: { authorName: "Pete", body: "IN 👍" }, want: ["self_att"] },
  { id: "F-bare-out", msg: { authorName: "Dan", body: "out" }, want: ["self_att"] },
  { id: "F-var", msg: { authorName: "Erdal", body: "var" }, want: ["self_att"] },
  { id: "F-yokum", msg: { authorName: "Erdal", body: "yokum" }, want: ["self_att"] },
  { id: "F-mention-in", msg: { authorName: "Kemal", body: "@Ehtisham Ul Haq In" }, want: ["other_att"] },
  { id: "F-mention-out", msg: { authorName: "Kemal", body: "@Zair Malik out" }, want: ["other_att"] },
  { id: "C-name-reply", msg: { authorName: "Kemal Ediz", body: "Idris" }, want: ["question"], opts: { clar: true } },
  { id: "C-in-reply", msg: { authorName: "Kemal Ediz", body: "I'm in" }, want: ["self_att"], opts: { clar: true } },
  { id: "S-answer-en", msg: { authorName: "Elvin", body: "Yellow" }, want: ["score"], opts: { scoreAnswer: true } },
  { id: "S-answer-tr", msg: { authorName: "Elvin", body: "sarılar" }, want: ["score"], opts: { scoreAnswer: true } },
  { id: "S-corr-swap", msg: { authorName: "Kemal", body: "@Match Time other way round" }, want: ["score"], opts: { correction: true } },
  { id: "S-corr-tr", msg: { authorName: "Kemal", body: "@Match Time yanlış, kırmızı 6 sarı 9" }, want: ["score"], opts: { correction: true } },
  { id: "S-corr-not-out", msg: { authorName: "Kemal", body: "@Match Time no, I'm out" }, want: ["self_att"], opts: { correction: true } },
];

async function routerCases(): Promise<void> {
  for (const c of ROUTER_CASES) {
    const id = c.id;
    const r = await routeBatch(model, [{ id, ...c.msg }], {
      now: NOW,
      ...(c.opts?.clar ? { clarifications: [CLAR] } : {}),
      ...(c.opts?.scoreAnswer ? { scoreAnswerIds: new Set([id]) } : {}),
      ...(c.opts?.correction ? { scoreCorrectionIds: new Set([id]) } : {}),
    });
    const got = r.routes[0];
    const routeOk = c.want.includes(got.route) && got.source === "model";
    const botOk = c.toBot === undefined || (got.toBot === true) === c.toBot;
    record(`router ${id}`, routeOk && botOk, { route: got.route, source: got.source, toBot: !!got.toBot }, `${c.want.join("|")}${c.toBot === undefined ? "" : ` to_bot ${c.toBot}`}`);
  }
}

const base = { tagged: false, history: [], lastBotPost: null, now: NOW };

async function extractorCases(): Promise<void> {
  // A joking drop: the claim is reported, at a confidence under the engine's floor (0.7).
  {
    const r = await extractForRoute(model, "other_att", { ...base, id: "E1", authorName: "Pete", body: "Zeeshan is out lol vote him out" });
    const c = r.facts.kind === "attendance" ? r.facts.claims.find((x) => x.subject === "other") : undefined;
    record("attendance E1-joke-low-confidence", !c || c.confidence < 0.7, c ? { confidence: c.confidence, polarity: c.polarity } : "no claim", "confidence < 0.7 or no claim");
  }
  {
    const r = await extractForRoute(model, "other_att", { ...base, id: "E2", authorName: "Pete", body: "Sam can't make it tonight" });
    const c = r.facts.kind === "attendance" ? r.facts.claims.find((x) => x.subject === "other") : undefined;
    record("attendance E2-plain-drop-kept", !!c && c.polarity === "out" && c.confidence >= 0.7, c ? { confidence: c.confidence, polarity: c.polarity } : "no claim", "out, confidence >= 0.7");
  }
  for (const [id, body] of [["E3-everyone", "@everyone in"], ["E4-brother", "my brother can play if needed"]] as const) {
    const r = await extractForRoute(model, "other_att", { ...base, id, authorName: "Amir", body });
    const others = r.facts.kind === "attendance" ? r.facts.claims.filter((x) => x.subject === "other") : [];
    record(`attendance ${id}`, others.every((x) => !x.personNamed), others.map((x) => ({ ref: x.personRef, named: x.personNamed })), "no named other");
  }
  // Score: an answer to "which team won?", and the asker's chatter.
  const ASK = "10 - 7 to which team?";
  for (const [id, body, want] of [
    ["S1-answer", "Yellow", "Yellow"],
    ["S2-chatter", "yellow bibs stink mate, reds deserved it anyway", ""],
    ["S3-question", "Yellow?", ""],
  ] as const) {
    const r = await extractForRoute(model, "score", { ...base, id, authorName: "Elvin", body, lastBotPost: ASK });
    const w = r.facts.kind === "score" ? (r.facts.winner ?? "") : "(not score)";
    record(`score ${id}`, want ? w.toLowerCase().includes(want.toLowerCase()) : w === "", { winner: w }, want ? `winner ${want}` : "no winner");
  }
  // Reminders: the London date and time, from NOW.
  for (const [id, body, want] of [
    ["A1-tomorrow-6", "@Match Time remind me tomorrow at 6 to bring the bibs", "2026-10-21 18:00"],
    ["A2-monday-morning-after-dst", "@Match Time remind me on Monday morning", "2026-10-26 09:00"],
    ["A3-tr", "@Match Time yarın akşam 8'de hatırlat", "2026-10-21 20:00"],
    ["A4-later", "@Match Time remind me later", ""],
  ] as const) {
    const r = await extractForRoute(model, "admin_ops", { ...base, tagged: true, id, authorName: "Zair", body });
    const at = r.facts.kind === "admin" ? (r.facts.remindAt ?? "") : "(not admin)";
    record(`admin ${id}`, at === want, { action: r.facts.kind === "admin" ? r.facts.action : null, remindAt: at }, want || "no remindAt");
  }
  // A clarification reply read against the original question.
  {
    const r = await extractForRoute(model, "question", {
      ...base,
      tagged: true,
      id: "Q1",
      authorName: "Kemal Ediz",
      body: CLAR.questionBody,
      clarifiedBy: "I mean Idris",
    });
    const ref = r.facts.kind === "question" ? r.facts.personRef : "(not question)";
    record("question Q1-clarified", (ref ?? "").toLowerCase().includes("idris"), { personRef: ref }, "personRef Idris");
  }
}

async function main(): Promise<void> {
  await routerCases();
  await extractorCases();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed; ${calls} model calls; $${usd.toFixed(4)} on the dev key`);
  writeFileSync(".e2e/live-check-no-parsing-p1.json", JSON.stringify({ results, calls, usd }, null, 2));
}
void main();
