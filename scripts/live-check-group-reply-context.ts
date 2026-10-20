/**
 * A GROUP REPLY CARRIES THE MESSAGE IT QUOTES: THE PAID CHECK (quoted-reply
 * context, slice S4, 2026-10-20).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only
 *     (ANTHROPIC_API_KEY_DEV), each case once. Pre-approved for S4 by Kemal.
 *
 * The unit tests stub the model; they prove the block reaches each prompt.
 * This proves the real models read it, through the exact prompts and turns
 * production sends (`routeBatch`, `extractForRoute`):
 *
 *   1. the router, players' group: "same" / "me too" / "ben de" replying to
 *      a member's IN, "he's out" replying to a member, IN replying to an
 *      old MatchTime squad post, a score correction replying to MatchTime's
 *      result ("no, it was 7-5 to yellow"), and banter replies (none);
 *   2. the router, organisers' group: YES replying to MatchTime's proposal;
 *   3. the attendance extractor: "same" is one claim, the sender's; "he's
 *      out" replying to Ali drops Ali;
 *   4. the score extractor: the correction is a correction;
 *   5. the question extractor: "same question" replying to a member's.
 *
 * ONE SCRIPT FOR BEFORE AND AFTER. On a checkout without slice S4 (no
 * `ROUTER_QUOTE_WORDS_MAX`) it builds what production sent before S4: a
 * MatchTime quote as the router's `quotedMatchTime` line and as the
 * question extractor's last post, and NOTHING for a quote of a member or
 * for the attendance and score extractors (they ignored quotes).
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-group-reply-context.ts
 *
 * No database, sends nothing. Prints each case, the calls and the cost.
 * WHAT ONE PASS CANNOT PROVE: an occasional miss can pass once and fail live.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import * as router from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 2;
spendDevApiKeyOrExit("the group reply-context live check");

const S4 = typeof (router as Record<string, unknown>).ROUTER_QUOTE_WORDS_MAX === "number";

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

// Tue 20 Oct 2026, 19:00 London; the match is tonight at 20:00.
const NOW = new Date("2026-10-20T18:00:00Z");
const TONIGHT = "Tuesday 7-a-side, Tue 20 Oct, 20:00";
const LAST_WEEK = "Tuesday 7-a-side, Tue 13 Oct, 20:00";
const OLD_SQUAD = "📋 *Squad for Tue 13 Oct* (13/14)\n1. Ali Khan\n2. Bilal Ahmed\n3. Tom Third\n\nNeed 1 more 🙏";
const RECORDED =
  "That match is already recorded: Red 7 - 5 Yellow. If that is wrong, just tell me in your own words, with the right score and the team that won (for example: no, it was 5-3).";
const TEAMS_TEXT = "📝 *Proposed teams*: 21:00 at Goals\n\n*Red*:\n1. Ali Khan\n2. Bilal Ahmed\n\n*Yellow*:\n1. Tom Third\n2. Can Demir\n\nReply YES to make them final.";

interface Quote {
  /** null: MatchTime's. "": a member not identified (review of #341). */
  author: string | null;
  text: string;
  minsAgo?: number;
  match?: string;
  topic?: "attendance" | "teamBalancing";
}

/** The quote as production shows it now (resolved), or before S4. */
function replyOf(q: Quote | undefined) {
  if (!q) return null;
  return {
    author: q.author === null ? null : { name: q.author || null },
    at: q.minsAgo !== undefined ? new Date(NOW.getTime() - q.minsAgo * 60_000) : null,
    text: q.text,
    topic: q.topic ?? null,
    matchId: null,
    match: q.match ?? null,
  };
}
function routerFields(q: Quote | undefined): Record<string, unknown> {
  if (!q) return {};
  if (S4) return { reply: replyOf(q) };
  return q.author === null ? { quotedMatchTime: q.text } : {};
}

interface RouterCase {
  /** Earlier messages in the same batch, before the one under test. */
  before?: Array<{ author: string; body: string }>;
  author: string;
  text: string;
  quote?: Quote;
  want: Route[];
  why: string;
}

const PLAYERS: RouterCase[] = [
  { before: [{ author: "Ali Khan", body: "IN" }], author: "Bo", text: "same", quote: { author: "Ali Khan", text: "IN", minsAgo: 1 }, want: ["self_att", "unsure"], why: "'same' to a member's IN, same batch" },
  { author: "Bo", text: "same", quote: { author: "Ali Khan", text: "IN", minsAgo: 20 }, want: ["self_att", "unsure"], why: "'same' to a member's IN, earlier" },
  { author: "Bo", text: "me too", quote: { author: "Ali Khan", text: "in for tonight 👍", minsAgo: 15 }, want: ["self_att", "unsure"], why: "'me too' to a member's IN" },
  { author: "Bo", text: "ben de", quote: { author: "Ali Khan", text: "varım", minsAgo: 15 }, want: ["self_att", "unsure"], why: "TR 'ben de' to a member's varım" },
  { author: "Bo", text: "same here, can't make it", quote: { author: "Ali Khan", text: "I'm out tonight lads", minsAgo: 10 }, want: ["self_att", "unsure"], why: "'same' to a member's OUT" },
  { author: "Bo", text: "@Match Time he's out", quote: { author: "Ali Khan", text: "stuck at work, not going to make it", minsAgo: 10 }, want: ["other_att", "unsure"], why: "'he's out' replying to a member" },
  { author: "Bo", text: "IN", quote: { author: null, text: OLD_SQUAD, minsAgo: 7 * 24 * 60, match: LAST_WEEK, topic: "attendance" }, want: ["self_att", "unsure"], why: "IN replying to last week's squad post" },
  { author: "Bo", text: "no, it was 7-5 to yellow", quote: { author: null, text: RECORDED }, want: ["score"], why: "score correction replying to MatchTime's result" },
  { author: "Bo", text: "hayır, 7-5 sarılar kazandı", quote: { author: null, text: RECORDED }, want: ["score"], why: "TR score correction replying to the result" },
  { author: "Bo", text: "no, it was 7-5 to yellow", quote: { author: null, text: "✅ Score recorded: Red 7 - 5 Yellow" }, want: ["score"], why: "correction replying to MatchTime's short result post" },
  { author: "Bo", text: "no, it was 7-5 to yellow", quote: { author: "Ali Khan", text: "7-5 to red tonight, well played lads", minsAgo: 30 }, want: ["score"], why: "correction replying to a MEMBER's result" },
  { author: "Bo", text: "haha same", quote: { author: "Ali Khan", text: "my legs are gone after last week 😂", minsAgo: 5 }, want: ["none"], why: "banter reply to a member" },
  { author: "Bo", text: "😂😂", quote: { author: "Ali Khan", text: "IN", minsAgo: 5 }, want: ["none"], why: "a laugh replying to a member's IN" },
  { author: "Bo", text: "who's bringing the bibs?", quote: { author: "Ali Khan", text: "IN", minsAgo: 5 }, want: ["none"], why: "a question to members, replying to an IN" },
];

interface HqCase {
  text: string;
  quote?: Quote;
  waiting: boolean;
  want: Route[];
  why: string;
}
const HQ: HqCase[] = [
  { text: "YES", quote: { author: null, text: TEAMS_TEXT, minsAgo: 20 }, waiting: true, want: ["approve"], why: "YES replying to MatchTime's proposal" },
  { text: "go ahead", quote: { author: null, text: TEAMS_TEXT, minsAgo: 20 }, waiting: true, want: ["approve"], why: "'go ahead' replying to the proposal" },
  { text: "tamam", quote: { author: null, text: TEAMS_TEXT, minsAgo: 20 }, waiting: true, want: ["approve"], why: "TR yes replying to the proposal" },
  { text: "yes I think so", quote: { author: "Hamzah", text: "shall we start at 8 instead?", minsAgo: 3 }, waiting: true, want: ["none", "approve"], why: "a yes to another organiser (code then keeps it silent)" },
];

const SAME_IN = (f: { claims?: Array<Record<string, unknown>> }) =>
  (f.claims ?? []).length === 1 && f.claims![0].subject === "sender" && f.claims![0].polarity === "in";

interface ExtractCase {
  route: Route;
  text: string;
  author: string;
  quote?: Quote;
  history?: Array<{ author: string | null; body: string }>;
  check: (facts: Record<string, unknown>) => boolean;
  why: string;
}
const EXTRACT: ExtractCase[] = [
  { route: "self_att", author: "Bo", text: "same", quote: { author: "Ali Khan", text: "IN", minsAgo: 1 }, history: [{ author: "Ali Khan", body: "IN" }], check: SAME_IN, why: "'same': one claim, the sender's, in" },
  { route: "self_att", author: "Bo", text: "me too", quote: { author: "Ali Khan", text: "in for tonight 👍", minsAgo: 15 }, check: SAME_IN, why: "'me too' with the IN only in the quote" },
  { route: "self_att", author: "Bo", text: "ben de", quote: { author: "Ali Khan", text: "varım", minsAgo: 15 }, check: SAME_IN, why: "TR 'ben de' with the varım only in the quote" },
  {
    route: "other_att",
    author: "Bo",
    text: "@Match Time he's out",
    quote: { author: "Ali Khan", text: "stuck at work, not going to make it", minsAgo: 10 },
    check: (f) => {
      const c = (f.claims as Array<Record<string, unknown>> | undefined) ?? [];
      return c.length === 1 && c[0].subject === "other" && /ali/i.test(String(c[0].personRef)) && c[0].polarity === "out";
    },
    why: "'he's out' replying to Ali: Ali out",
  },
  {
    route: "other_att",
    author: "Bo",
    text: "@Match Time he's out",
    quote: { author: "", text: "stuck at work, not going to make it", minsAgo: 10 },
    check: (f) => {
      const c = (f.claims as Array<Record<string, unknown>> | undefined) ?? [];
      // Nobody may be named from an unidentified author: "he" stays "he"
      // (code then resolves it to no one and writes nothing).
      return c.every((x) => !/ali/i.test(String(x.personRef)) && (x.subject !== "other" || x.personNamed === false || /^(he|him)$/i.test(String(x.personRef))));
    },
    why: "'he's out' replying to a member NOT identified: names nobody",
  },
  {
    route: "self_att",
    author: "Bo",
    // The attendance owner drops a quote of another match's post
    // (`quoteForMatch`): production shows no quote here, before or after.
    text: "IN",
    check: SAME_IN,
    why: "IN replying to last week's squad post (the quote is not shown)",
  },
  {
    route: "score",
    author: "Bo",
    text: "no, it was 7-5 to yellow",
    quote: { author: null, text: RECORDED },
    check: (f) => f.first === 7 && f.second === 5 && /yellow/i.test(String(f.winner)) && f.correction === true,
    why: "the correction replying to the result",
  },
  {
    route: "score",
    author: "Bo",
    text: "hayır, 7-5 sarılar kazandı",
    quote: { author: null, text: RECORDED },
    check: (f) => f.first === 7 && f.second === 5 && f.correction === true,
    why: "TR correction replying to the result",
  },
  {
    route: "score",
    author: "Bo",
    text: "no, it was 7-5 to yellow",
    quote: { author: "Ali Khan", text: "7-5 to red tonight, well played lads", minsAgo: 30 },
    check: (f) => f.first === 7 && f.second === 5 && /yellow/i.test(String(f.winner)) && f.correction === true,
    why: "the correction replying to a member's result",
  },
  {
    route: "question",
    author: "Bo",
    text: "@Match Time same question",
    quote: { author: "Ali Khan", text: "does anyone know what time kick off is tonight?", minsAgo: 4 },
    check: (f) => f.topic === "fixture",
    why: "'same question' replying to a member's kickoff question",
  },
];

async function main() {
  let pass = 0;
  let fail = 0;
  const mark = (ok: boolean) => (ok ? (pass++, "PASS") : (fail++, "FAIL"));
  console.log(`[group-reply] prompt: ${S4 ? "NEW (slice S4)" : "OLD (before S4)"}`);

  console.log(`\n== Router, players' group: ${PLAYERS.length} cases, each once, floor OFF ==\n`);
  for (const [i, c] of PLAYERS.entries()) {
    const before = (c.before ?? []).map((b, j) => ({ id: `p${i}b${j}`, authorName: b.author, body: b.body }));
    const id = `p${i}`;
    const r = await router.routeBatch(
      model,
      [...before, { id, authorName: c.author, body: c.text, ...routerFields(c.quote) } as router.RouterMessage],
      { floor: false, awaiting: null, ...(S4 ? { now: NOW } : {}) } as router.RouteBatchOptions,
    );
    const route = r.routes.find((x) => x.messageId === id)?.route;
    console.log(`${mark(!!route && c.want.includes(route))}  ${JSON.stringify(c.text)}  routed ${route}   (${c.why}; want ${c.want.join("|")})`);
  }

  console.log(`\n== Router, organisers' group: ${HQ.length} cases, each once ==\n`);
  for (const [i, c] of HQ.entries()) {
    const pending = c.waiting ? [{ ref: "teams:m1", kind: "teams" as const, day: "Tue 20 Oct", askedAt: new Date(NOW.getTime() - 20 * 60_000) }] : [];
    const recent = c.waiting ? [{ fromMatchTime: true, text: TEAMS_TEXT }] : [];
    const context = S4
      ? organisersContext({ pending, recent } as Parameters<typeof organisersContext>[0])
      : organisersContext({
          pending,
          recent,
          quoted: c.quote ? { text: c.quote.text, fromMatchTime: c.quote.author === null } : null,
          quotedIsMatchTime: c.quote?.author === null,
        } as unknown as Parameters<typeof organisersContext>[0]);
    const id = `h${i}`;
    const r = await router.routeBatch(
      model,
      [{ id, authorName: "Raihan", body: c.text, organisers: { context }, ...(S4 && c.quote ? { reply: replyOf(c.quote) } : {}) } as router.RouterMessage],
      { floor: true, ...(S4 ? { now: NOW } : {}) } as router.RouteBatchOptions,
    );
    const route = r.routes[0]?.route;
    console.log(`${mark(!!route && c.want.includes(route))}  ${JSON.stringify(c.text)}  routed ${route}   (${c.why}; want ${c.want.join("|")})`);
  }

  console.log(`\n== Extractors: ${EXTRACT.length} cases, each once ==\n`);
  for (const [i, c] of EXTRACT.entries()) {
    const reply = replyOf(c.quote);
    const msg = {
      id: `x${i}`,
      body: c.text,
      authorName: c.author,
      tagged: c.text.includes("@Match Time") || c.quote?.author === null,
      history: c.history ?? [],
      lastBotPost: null as string | null,
    };
    // Before S4 only the question extractor read a quote, and only
    // MatchTime's, as its last post.
    const shaped = S4
      ? { ...msg, reply, now: NOW }
      : c.route === "question" && c.quote?.author === null
        ? { ...msg, lastBotPost: c.quote.text }
        : msg;
    const ex = await extractForRoute(model, c.route, shaped);
    const facts = ex.facts as unknown as Record<string, unknown>;
    console.log(`${mark(c.check(facts))}  ${c.route}  ${JSON.stringify(c.text)}  ${JSON.stringify(facts)}   (${c.why})`);
  }

  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
