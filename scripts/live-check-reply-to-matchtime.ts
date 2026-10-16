/**
 * A REPLY TO MATCHTIME IS A TAG: THE PAID CHECK (2026-10-16, FNF).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Approved by Kemal on
 *     2026-10-16 for this change: dev key only, each case once.
 *
 * The unit and e2e tests stub the model; they prove the wiring (the Pi's
 * quoted fields, the tag, the REPLYING TO line, ownership, the help copy).
 * This proves the real models read it, ONCE per case, through the exact
 * prompts and turns production sends (`renderRouterTurn` via `routeBatch`,
 * `extractForRoute` with the quoted post as MatchTime's post):
 *
 *   1. the router, players' group: a reply to MatchTime's bench post that
 *      asks about the bench is `question`, an IN reply is attendance, a
 *      laugh or thanks is `none`; EN and TR, held-out wordings;
 *   2. the router, organisers' group: the replies the HQ check already had,
 *      since a reply to MatchTime is now named a tag in the shared prompt;
 *   3. the rewritten question extractor: the new `how_it_works` topic, and
 *      one case for every topic it already classified (the regression).
 *
 * The players' group router regressions are the existing harness, run
 * once beside this: `MT_REGRESSION_REPEATS=1 npm run replay:router-regressions`.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-reply-to-matchtime.ts
 *   ONLY=router ...   the two router sections only (after a router-only change)
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
import type { QuestionFacts, Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 2;

spendDevApiKeyOrExit("the reply-to-MatchTime live check");

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

/** The FNF post, as `full_squad_bench_invite_organiser` renders it. */
const BENCH_POST =
  "*Football 9-a-side* is full at 18 of 18, but the bench is open. Say *IN* to go on the bench, and the organisers will pick who plays. 🙏";
const SQUAD_POST = "📋 *Squad for Fri 16 Oct* (12/18)\n1. Ali Khan\n2. Bilal Ahmed\n3. Tom Third\n\nNeed 6 more 🙏";

interface RouterCase {
  text: string;
  /** The MatchTime post it replies to; absent: an ordinary message. */
  quoted?: string;
  want: Route[];
  why: string;
}

const PLAYERS: RouterCase[] = [
  // The incident, and held-out wordings of it.
  { text: "Bench? We do bench now?", quoted: BENCH_POST, want: ["question"], why: "the incident (in the prompt)" },
  { text: "since when do we have a bench?", quoted: BENCH_POST, want: ["question"], why: "held out" },
  { text: "how does the waiting list work here?", quoted: BENCH_POST, want: ["question"], why: "held out" },
  { text: "Yedek mi var artık?", quoted: BENCH_POST, want: ["question"], why: "held out, TR" },
  { text: "so who decides who plays from the bench?", quoted: BENCH_POST, want: ["question"], why: "held out" },
  { text: "how many are we?", quoted: SQUAD_POST, want: ["question"], why: "a squad question as a reply" },
  // Attendance as a reply: unchanged handling.
  { text: "IN", quoted: BENCH_POST, want: ["self_att", "unsure"], why: "IN as a reply (in the prompt)" },
  { text: "put me on the bench then", quoted: BENCH_POST, want: ["self_att", "unsure"], why: "held out" },
  { text: "ben de varım", quoted: BENCH_POST, want: ["self_att", "unsure"], why: "TR join as a reply" },
  { text: "out, sorry lads", quoted: SQUAD_POST, want: ["self_att", "unsure"], why: "OUT as a reply" },
  // Banter as a reply: tagged, but asks for nothing.
  { text: "😂😂", quoted: BENCH_POST, want: ["none"], why: "a laugh" },
  { text: "cheers mate", quoted: SQUAD_POST, want: ["none"], why: "thanks" },
  { text: "haha nice one", quoted: BENCH_POST, want: ["none"], why: "banter" },
  { text: "eyvallah", quoted: SQUAD_POST, want: ["none"], why: "thanks, TR" },
  // Not a reply to MatchTime: the router sees no line (code refuses an
  // untagged question anyway). Reported, either answer is silent.
  { text: "Bench? We do bench now?", want: ["none", "question"], why: "the same words, untagged: the gate refuses a question" },
];

interface HqCase {
  text: string;
  quoted?: { text: string; fromMatchTime: boolean };
  waiting: boolean;
  want: Route[];
  why: string;
}
const TEAMS_TEXT = "📝 *Proposed teams*: 21:00 at Goals Sutton\n\n*Red*:\n1. Ali Khan\n2. Bilal Ahmed\n\n*Yellow*:\n1. Tom Third\n2. Sam Stone\n\nReply *YES* to make them final.";
const HQ: HqCase[] = [
  { text: "YES", quoted: { text: TEAMS_TEXT, fromMatchTime: true }, waiting: true, want: ["approve"], why: "YES quoted to the teams (HQ check case)" },
  { text: "yes", quoted: { text: "shall we start at 8 instead?", fromMatchTime: false }, waiting: true, want: ["approve", "none"], why: "YES quoting an organiser (HQ check case; main's prompt routes it unsure too, measured 2026-10-16)" },
  { text: "thanks 👍", quoted: { text: TEAMS_TEXT, fromMatchTime: true }, waiting: true, want: ["none"], why: "thanks to MatchTime in HQ (unsure on main; a first wording here made it approve, which is why the reply rule is players' group only)" },
  { text: "who is bringing the bibs?", waiting: true, want: ["none"], why: "chatter (HQ check case; unsure on main too, measured 2026-10-16)" },
  { text: "Tom out", waiting: false, want: ["other_att"], why: "squad change (HQ check case)" },
];

interface QCase {
  text: string;
  lastBotPost?: string;
  check: (f: QuestionFacts) => boolean;
  why: string;
}
const Q: QCase[] = [
  // The new topic.
  { text: "Bench? We do bench now?", lastBotPost: BENCH_POST, check: (f) => f.topic === "how_it_works" && f.feature === "availability", why: "the incident (in the prompt)" },
  { text: "since when do we have a bench?", lastBotPost: BENCH_POST, check: (f) => f.topic === "how_it_works" && f.feature === "availability", why: "held out" },
  { text: "Yedek mi var artık?", lastBotPost: BENCH_POST, check: (f) => f.topic === "how_it_works" && f.feature === "availability", why: "held out, TR" },
  { text: "so who decides who plays from the bench?", lastBotPost: BENCH_POST, check: (f) => f.topic === "how_it_works" && f.feature === "availability", why: "held out" },
  { text: "@Match Time how do the ratings work?", check: (f) => f.topic === "how_it_works" && f.feature === "ratings", why: "held out, another part" },
  { text: "@Match Time how do I pay?", check: (f) => f.topic === "how_it_works" && f.feature === "payments", why: "held out, another part" },
  // Every topic it already classified: the regression.
  { text: "@Match Time who's on the bench?", check: (f) => f.topic === "bench", why: "bench is WHO (in the prompt)" },
  { text: "@Match Time anyone waiting on the bench this week?", check: (f) => f.topic === "bench", why: "bench is WHO, held out" },
  { text: "@Match Time who's in?", check: (f) => f.topic === "squad", why: "squad" },
  { text: "@Match Time how many spots left?", check: (f) => f.topic === "count", why: "count" },
  { text: "@Match Time we're 9/14 right?", check: (f) => f.topic === "count" && f.statedCount === 9, why: "count, stated" },
  { text: "@Match Time is Zair in?", check: (f) => f.topic === "person_status" && /zair/i.test(f.personRef ?? ""), why: "person_status" },
  { text: "@Match Time anyone in the squad without a number?", check: (f) => f.topic === "phones", why: "phones" },
  { text: "@Match Time maç kaçta?", check: (f) => f.topic === "fixture", why: "fixture, TR" },
  { text: "@Match Time give us the scores of the last 5 matches", check: (f) => f.topic === "score" && f.listSize === 5, why: "score, list" },
  { text: "@Match Time kim ödemedi?", check: (f) => f.topic === "payments", why: "payments, TR" },
  { text: "@Match Time who hasn't rated yet?", check: (f) => f.topic === "rating_progress", why: "rating_progress" },
  { text: "@Match Time istatistiklerim", check: (f) => f.topic === "my_stats", why: "my_stats, TR" },
  { text: "@Match Time top 5 ratings in the last month", check: (f) => f.topic === "stats" && f.table === "ratings" && f.listSize === 5 && f.period?.kind === "last", why: "stats, table, size, period" },
  { text: "@Match Time we're short, what are our options?", check: (f) => f.topic === "options", why: "options" },
  { text: "@Match Time how much do we pay each?", check: (f) => f.topic === "club", why: "the fee is club since 2026-10-16 (in the prompt)" },
];

async function main() {
  let pass = 0;
  let fail = 0;
  const mark = (ok: boolean) => (ok ? (pass++, "PASS") : (fail++, "FAIL"));

  console.log(`\n== Router, players' group: ${PLAYERS.length} cases, each once, floor OFF ==\n`);
  for (const [i, c] of PLAYERS.entries()) {
    const r = await routeBatch(model, [{ id: `p${i}`, authorName: "Can", body: c.text, ...(c.quoted ? { quotedMatchTime: c.quoted } : {}) }], { floor: false, awaiting: null });
    const route = r.routes[0]?.route;
    console.log(`${mark(!!route && c.want.includes(route))}  ${JSON.stringify(c.text)}${c.quoted ? " (reply to MatchTime)" : ""}  routed ${route}   (${c.why}; want ${c.want.join("|")})`);
  }

  console.log(`\n== Router, organisers' group: ${HQ.length} cases, each once ==\n`);
  for (const [i, c] of HQ.entries()) {
    const context = organisersContext({
      pending: c.waiting ? [{ ref: "teams:m1", kind: "teams", day: "Fri 16 Oct", askedAt: new Date("2026-10-16T09:00:00Z") }] : [],
      quoted: c.quoted ?? null,
      quotedIsMatchTime: c.quoted?.fromMatchTime ?? false,
      recent: c.waiting ? [{ fromMatchTime: true, text: TEAMS_TEXT }] : [],
    });
    const r = await routeBatch(model, [{ id: `h${i}`, authorName: "Raihan", body: c.text, organisers: { context } }], { floor: true });
    const route = r.routes[0]?.route;
    console.log(`${mark(!!route && c.want.includes(route))}  ${JSON.stringify(c.text)}  routed ${route}   (${c.why}; want ${c.want.join("|")})`);
  }

  if (process.env.ONLY !== "router") console.log(`\n== Question extractor: ${Q.length} cases, each once ==\n`);
  for (const [i, c] of process.env.ONLY === "router" ? [] : Q.entries()) {
    const ex = await extractForRoute(model, "question", { id: `q${i}`, body: c.text, authorName: "Can", tagged: true, history: [], lastBotPost: c.lastBotPost ?? null });
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
