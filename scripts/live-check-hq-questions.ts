/**
 * QUESTIONS IN THE ADMIN GROUP: THE PAID CHECK (2026-10-16, FNF HQ).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Approved by Kemal on
 *     2026-10-16 for HQ work: dev key only, each case once.
 *
 * "MatchTime who are the admins?" was routed `help` and answered with the
 * HQ menu. HQ's `question` and `help` now go through the players' group's
 * question extractor (`admin-group-question.ts`), which gained the `club`
 * topic. This proves the real models read it, ONCE per case, through the
 * exact prompts and turns production sends:
 *
 *   1. the router (prompt unchanged), organisers' group: each HQ question
 *      must reach the answering code, `question` or `help`, never none;
 *   2. the question extractor on those questions, EN and TR;
 *   3. the question extractor's regressions: one case for every topic it
 *      already classified (the set `live-check-reply-to-matchtime.ts` ran).
 *
 *   node --env-file=../../../.env ./node_modules/.bin/tsx scripts/live-check-hq-questions.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost. Stops at
 * MAX_USD. WHAT ONE PASS CANNOT PROVE: an occasional miss can pass once
 * and fail live.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { QuestionFacts, QuestionTopic, Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 2;

spendDevApiKeyOrExit("the HQ questions live check");

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

const BENCH_POST =
  "*Football 9-a-side* is full at 18 of 18, but the bench is open. Say *IN* to go on the bench, and the organisers will pick who plays. 🙏";

interface HqQuestion {
  text: string;
  topics: QuestionTopic[];
  why: string;
}
const HQ: HqQuestion[] = [
  { text: "MatchTime who are the admins?", topics: ["club"], why: "the incident" },
  { text: "MatchTime yöneticiler kim?", topics: ["club"], why: "the incident, TR" },
  { text: "who's on the bench?", topics: ["bench"], why: "bench" },
  { text: "yedekte kimler var?", topics: ["bench"], why: "bench, TR" },
  { text: "@Match Time how many are in?", topics: ["count", "squad"], why: "count" },
  { text: "@Match Time kaç kişi var?", topics: ["count", "squad"], why: "count, TR" },
  { text: "MatchTime when are the teams made?", topics: ["club"], why: "the teams time" },
  { text: "MatchTime takımlar ne zaman kuruluyor?", topics: ["club"], why: "the teams time, TR" },
  { text: "MatchTime who collects the money?", topics: ["club"], why: "the collector" },
  { text: "MatchTime parayı kim topluyor?", topics: ["club"], why: "the collector, TR" },
  { text: "what can you do?", topics: ["how_it_works"], why: "a genuine help question: the HQ menu" },
];

/** Players' group (manager review of #296): the fee and the teams time, held out
 *  from the prompt's own examples, EN and TR. */
const PLAYERS = [
  "@Match Time what's the fee this week?",
  "@Match Time when will the teams be out?",
  "@Match Time bu hafta ücret ne kadar?",
  "@Match Time takımlar ne zaman belli olur?",
];

interface QCase {
  text: string;
  lastBotPost?: string;
  check: (f: QuestionFacts) => boolean;
  why: string;
}
const REGRESSIONS: QCase[] = [
  { text: "Bench? We do bench now?", lastBotPost: BENCH_POST, check: (f) => f.topic === "how_it_works" && f.feature === "availability", why: "how_it_works (in the prompt)" },
  { text: "Yedek mi var artık?", lastBotPost: BENCH_POST, check: (f) => f.topic === "how_it_works" && f.feature === "availability", why: "how_it_works, TR" },
  { text: "@Match Time how are the teams picked?", check: (f) => f.topic === "how_it_works" && f.feature === "teams", why: "HOW the teams are made stays how_it_works (in the prompt)" },
  { text: "@Match Time how do the ratings work?", check: (f) => f.topic === "how_it_works" && f.feature === "ratings", why: "how_it_works, ratings" },
  { text: "@Match Time how do I pay?", check: (f) => f.topic === "how_it_works" && f.feature === "payments", why: "how_it_works, payments" },
  { text: "@Match Time who's on the bench?", check: (f) => f.topic === "bench", why: "bench (in the prompt)" },
  { text: "@Match Time who's in?", check: (f) => f.topic === "squad", why: "squad" },
  { text: "@Match Time how many spots left?", check: (f) => f.topic === "count", why: "count" },
  { text: "@Match Time we're 9/14 right?", check: (f) => f.topic === "count" && f.statedCount === 9, why: "count, stated" },
  { text: "@Match Time is Zair in?", check: (f) => f.topic === "person_status" && /zair/i.test(f.personRef ?? ""), why: "person_status" },
  { text: "@Match Time anyone in the squad without a number?", check: (f) => f.topic === "phones", why: "phones" },
  { text: "@Match Time maç kaçta?", check: (f) => f.topic === "fixture", why: "fixture, TR" },
  { text: "@Match Time give us the scores of the last 5 matches", check: (f) => f.topic === "score" && f.listSize === 5, why: "score, list" },
  { text: "@Match Time kim ödemedi?", check: (f) => f.topic === "payments", why: "payments, TR" },
  { text: "@Match Time has everyone paid for last week?", check: (f) => f.topic === "payments", why: "payments, held out against club" },
  { text: "@Match Time who hasn't rated yet?", check: (f) => f.topic === "rating_progress", why: "rating_progress" },
  { text: "@Match Time istatistiklerim", check: (f) => f.topic === "my_stats", why: "my_stats, TR" },
  { text: "@Match Time top 5 ratings in the last month", check: (f) => f.topic === "stats" && f.table === "ratings" && f.listSize === 5 && f.period?.kind === "last", why: "stats, table, size, period" },
  { text: "@Match Time we're short, what are our options?", check: (f) => f.topic === "options", why: "options" },
  { text: "@Match Time how much do we pay each?", check: (f) => f.topic === "club", why: "the fee is club now (in the prompt)" },
];

async function main() {
  let pass = 0;
  let fail = 0;
  const mark = (ok: boolean) => (ok ? (pass++, "PASS") : (fail++, "FAIL"));
  const context = organisersContext({ pending: [], quoted: null, quotedIsMatchTime: false, recent: [] });

  // ONLY=players: the players' group section and the regressions only (a
  // rerun after `club` became answerable there; no prompt changed).
  const playersOnly = process.env.ONLY === "players";
  // ROUTER_ONLY="a|b": the router on those texts only (a rerun after a
  // case's wording changed; the router prompt is untouched by this change).
  const routerOnly = process.env.ROUTER_ONLY?.split("|");
  const routerCases = playersOnly ? [] : routerOnly ? HQ.filter((c) => routerOnly.includes(c.text)) : HQ;
  console.log(`\n== Router (unchanged), organisers' group: ${routerCases.length} cases, each once ==\n`);
  const want: Route[] = ["question", "help"];
  for (const [i, c] of routerCases.entries()) {
    const r = await routeBatch(model, [{ id: `h${i}`, authorName: "Hamzah", body: c.text, organisers: { context } }], { floor: true });
    const route = r.routes[0]?.route;
    console.log(`${mark(!!route && want.includes(route))}  ${JSON.stringify(c.text)}  routed ${route}   (${c.why}; want question|help)`);
  }

  // The players' group: a tagged fee or teams-time question must reach the
  // answering code (router: question) and read as `club` (extractor).
  console.log(`\n== Players' group, club questions: ${PLAYERS.length} cases, router + extractor, each once ==\n`);
  for (const [i, c] of PLAYERS.entries()) {
    const r = await routeBatch(model, [{ id: `p${i}`, authorName: "Can", body: c }], { floor: false, awaiting: null });
    const route = r.routes[0]?.route;
    console.log(`${mark(route === "question")}  ${JSON.stringify(c)}  routed ${route}   (want question)`);
    const ex = await extractForRoute(model, "question", { id: `pq${i}`, body: c, authorName: "Can", tagged: true, history: [], lastBotPost: null });
    const f = ex.facts.kind === "question" ? ex.facts : null;
    console.log(`${mark(f?.topic === "club")}  ${JSON.stringify(c)}  ${f?.topic}   (want club)`);
  }

  const hqCases = playersOnly ? [] : HQ;
  console.log(`\n== Question extractor, the HQ questions: ${hqCases.length} cases, each once ==\n`);
  for (const [i, c] of hqCases.entries()) {
    const ex = await extractForRoute(model, "question", { id: `q${i}`, body: c.text, authorName: "Hamzah", tagged: true, history: [], lastBotPost: null });
    const f = ex.facts.kind === "question" ? ex.facts : null;
    console.log(`${mark(!!f && c.topics.includes(f.topic))}  ${JSON.stringify(c.text)}  ${f?.topic}${f?.feature ? `/${f.feature}` : ""}   (${c.why}; want ${c.topics.join("|")})`);
  }

  console.log(`\n== Question extractor, regressions: ${REGRESSIONS.length} cases, each once ==\n`);
  for (const [i, c] of REGRESSIONS.entries()) {
    const ex = await extractForRoute(model, "question", { id: `r${i}`, body: c.text, authorName: "Can", tagged: true, history: [], lastBotPost: c.lastBotPost ?? null });
    const f = ex.facts.kind === "question" ? ex.facts : null;
    console.log(`${mark(!!f && c.check(f))}  ${JSON.stringify(c.text)}  ${JSON.stringify(f && { topic: f.topic, feature: f.feature, personRef: f.personRef, statedCount: f.statedCount, table: f.table, listSize: f.listSize, period: f.period })}   (${c.why})`);
  }

  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
