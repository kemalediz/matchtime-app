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
  { text: "@Match Time what is squad now including bench?", topics: ["squad", "bench"], why: "FNF 2026-10-18 13:32" },
];

/**
 * FNF HQ, 2026-10-18 13:32 London, as production routed it: the real
 * WhatsApp id (which the router once echoed back miscopied, "B03" twice;
 * it is now shown "m1" and the code maps it back), the
 * HQ context that was shown above it, the text as the Pi forwarded it, and
 * the raw "@<digits>" form a mention takes before the Pi names MatchTime.
 */
const INCIDENT_ID = "false_120363046757382958@g.us_AC5922E2E21D4093AAD157B03EDDADA1_89485761081551@lid";
const INCIDENT_TEXTS = ["@Match Time what is squad now including bench?", "@270000000000001 what is squad now including bench?"];
const INCIDENT_CONTEXT = organisersContext({
  pending: [],
  recent: [
    "Thought that was the quickest recovery",
    "Ill be back on 30th or 6th the latest inshallah",
    "Hamz dont beg it and try join same time bro",
    "",
    "I should be back in the first week of November, insha'Allah",
  ].map((text) => ({ fromMatchTime: false, text })),
  score: { kind: "result", day: "Fri 16 Oct", labels: ["Non Bibs", "Bibs"] },
});

/**
 * FNF HQ, 2026-10-20 10:23 UTC (Raihan), squad 17 of 18, bench empty:
 * "Anyone on the bench? Can you show me the list please" (a reply to
 * MatchTime's "Done: Naim out. 17 of 18.") and then "What's the list"
 * both came back `bench` and got "Nobody's on the bench right now." The
 * two messages exactly as production built them (HQ's log holds only the
 * people's lines), then held-out wordings, EN and TR, and the bench
 * questions that must stay `bench`.
 */
const DONE_POST = "Done: Naim out. 17 of 18.";
const LIST_M2 = "Anyone on the bench? Can you show me the list please";
const LIST_HISTORY = [
  { author: null, body: "Naim is out" },
  { author: null, body: "Naim out" },
];
const LIST_REPLY = { at: new Date("2026-10-20T10:23:05Z"), text: DONE_POST, topic: null, match: null, author: null, matchId: "m-fri", found: true };
interface ListCase {
  text: string;
  history?: Array<{ author: string | null; body: string }>;
  reply?: typeof LIST_REPLY;
  want: QuestionTopic;
  why: string;
}
const LIST: ListCase[] = [
  { text: LIST_M2, history: LIST_HISTORY, reply: LIST_REPLY, want: "squad", why: "the incident, 10:23:38, a reply to MatchTime" },
  { text: "What\u2019s the list", history: [...LIST_HISTORY, { author: null, body: LIST_M2 }], want: "squad", why: "the incident, 10:23:59, the bench question above it" },
  { text: "is there anyone on the bench? send the list pls", want: "squad", why: "held out" },
  { text: "Bench anyone? And the list", want: "squad", why: "held out" },
  { text: "list?", history: [{ author: null, body: "who's on the bench?" }], want: "squad", why: "held out, bench asked above" },
  { text: "Yedek var mı? Listeyi paylaşır mısın", want: "squad", why: "held out, TR" },
  { text: "liste nedir", history: [{ author: null, body: "yedekte kim var?" }], want: "squad", why: "held out, TR, bench asked above" },
  { text: "Listeyi gönder", want: "squad", why: "held out, TR" },
  { text: "anyone on the bench?", want: "bench", why: "the bench alone stays bench" },
  { text: "what's the bench list?", want: "bench", why: "the bench's own list stays bench" },
  { text: "yedekte kimse var mı?", want: "bench", why: "the bench alone, TR" },
  { text: "yedek listesi ne?", want: "bench", why: "the bench's own list, TR" },
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
  const context = organisersContext({ pending: [], recent: [] });

  // ONLY=list: the 2026-10-20 list incident section alone.
  if (process.env.ONLY === "list") {
    await listSection(mark);
    console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
    process.exit(fail > 0 ? 1 : 0);
  }

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

  // The incident, with its real id and context: the router's route must
  // reach the message (no fallback) and be question|help.
  if (!playersOnly && !routerOnly) {
    console.log(`\n== The 2026-10-18 incident, its real id and HQ context: ${INCIDENT_TEXTS.length} cases, router once each ==\n`);
    for (const text of INCIDENT_TEXTS) {
      const r = await routeBatch(model, [{ id: INCIDENT_ID, authorName: "Kemal", body: text, organisers: { context: INCIDENT_CONTEXT } }], { floor: true });
      const got = r.routes[0];
      // The model is shown "m1", never the WhatsApp id; the route must come
      // back on the real id, by the model, with no fallback.
      console.log(`${mark(got?.messageId === INCIDENT_ID && got.source === "model" && want.includes(got.route))}  ${JSON.stringify(text)}  routed ${got?.route} by ${got?.source}   (want question|help by model)`);
    }
    // The raw form through the question extractor too (the Pi's form is in
    // the HQ list below).
    const raw = INCIDENT_TEXTS[1];
    const ex = await extractForRoute(model, "question", { id: "qi", body: raw, authorName: "Kemal", tagged: true, history: [], lastBotPost: null });
    const f = ex.facts.kind === "question" ? ex.facts : null;
    console.log(`${mark(!!f && ["squad", "bench"].includes(f.topic))}  ${JSON.stringify(raw)}  ${f?.topic}   (want squad|bench)`);
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

  if (!playersOnly && !routerOnly) await listSection(mark);

  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

async function listSection(mark: (ok: boolean) => string) {
  console.log(`\n== The 2026-10-20 list incident: router on the two incident messages, extractor on ${LIST.length} cases, each once ==\n`);
  const now = new Date("2026-10-20T10:24:00Z");
  for (const c of LIST.slice(0, 2)) {
    const recent = (c.history ?? []).map((h) => ({ fromMatchTime: false, text: h.body }));
    const r = await routeBatch(
      model,
      [{ id: "l1", authorName: "Raihan", body: c.text, organisers: { context: organisersContext({ pending: [], recent }) }, ...(c.reply ? { reply: c.reply } : {}) }],
      { floor: true, now },
    );
    const route = r.routes[0]?.route;
    console.log(`${mark(route === "question" || route === "help")}  ${JSON.stringify(c.text)}  routed ${route}   (want question|help)`);
  }
  for (const [i, c] of LIST.entries()) {
    const ex = await extractForRoute(model, "question", {
      id: `l${i}`,
      body: c.text,
      authorName: "Raihan",
      tagged: true,
      history: c.history ?? [],
      lastBotPost: null,
      reply: c.reply ?? null,
      now,
    });
    const f = ex.facts.kind === "question" ? ex.facts : null;
    console.log(`${mark(f?.topic === c.want)}  ${JSON.stringify(c.text)}  ${f?.topic}   (${c.why}; want ${c.want})`);
  }
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
