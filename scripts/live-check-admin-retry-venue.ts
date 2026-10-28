/**
 * "TRY AGAIN" AND "SET THE PITCH" BY WHATSAPP: THE PAID CHECK (2026-10-28,
 * MT Test 15:40 UTC: "@Match Time added the venue location" right after
 * MatchTime refused to ask the pool was read `other`, and the organiser got
 * "I can't change that by message").
 *
 * Each case ONCE through the real router and the real admin extractor, the
 * way production reads it: the router's route, then the admin extractor
 * with MatchTime's last post as context. The extractor is read whatever the
 * route, so a router miss and an extractor miss are told apart.
 *
 *   PG      the players' group (no organisers' header): admin_ops reads it
 *   HQ      the organisers' group, with the refusal in its recent lines:
 *           admin_ops (or ask_group) reads it
 *
 *   npx tsx --env-file=.env scripts/live-check-admin-retry-venue.ts
 *   MEASURE=1 ...   one real call pair, its tokens and cost, then stop
 *   ONLY=<text> ... the cases whose text contains it
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { adminVenueCopy } from "../src/lib/i18n/admin-venue.ts";
import { poolAskRefusalText } from "../src/lib/pool/offer-copy.ts";
import type { AdminFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
spendDevApiKeyOrExit("the admin retry and pitch live check");

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
    if (process.env.MEASURE) console.log(`[measure] ${req.label}: in ${r.usage.inputTokens} + cache read ${r.usage.cacheReadTokens} + cache write ${r.usage.cacheWriteTokens}, out ${r.usage.outputTokens}, $${(r.costUsd ?? 0).toFixed(5)}`);
    return r;
  },
};

const NOW = new Date("2026-10-28T15:40:00Z");
const REFUSED = poolAskRefusalText("en", "no-venue", 1);
const REFUSED_TR = poolAskRefusalText("tr", "no-venue", 1);
const LIST = adminVenueCopy("en").which({ words: "Goals Sutton", options: ["Goals Sutton, Oxford Road, Sutton, UK", "Goals Sutton, Sutton Common Road, Sutton, UK"] });
const LIST_TR = adminVenueCopy("tr").which({ words: "Goals Sutton", options: ["Goals Sutton, Oxford Road, Sutton, UK", "Goals Sutton, Sutton Common Road, Sutton, UK"] });

/** What the case wants of the facts: "retry", "venue:<name>", "venue:<name>#<n>", or "not-new" (neither new action). */
type Want = string;
const got = (f: AdminFacts | null): Want =>
  f?.action === "retry_ask" ? "retry" : f?.action === "set_venue" ? `venue:${f.venueName ?? ""}${f.venueChoice ? `#${f.venueChoice}` : ""}` : `not-new(${f?.action ?? "none"})`;
const matches = (want: Want, g: Want) => (want === "not-new" ? g.startsWith("not-new") : want === g);

interface Case { text: string; last: string | null; want: Want; why: string; hq?: boolean }
const CASES: Case[] = [
  { text: "@Match Time added the venue location", last: REFUSED, want: "retry", why: "THE LIVE CASE" },
  { text: "@Match Time tamam ekledim", last: REFUSED_TR, want: "retry", why: "TR: ok, added it" },
  { text: "@Match Time done, try again", last: REFUSED, want: "retry", why: "try again" },
  { text: "@Match Time şimdi dene", last: REFUSED_TR, want: "retry", why: "TR: try now" },
  { text: "@Match Time our pitch is Goals Sutton", last: null, want: "venue:Goals Sutton", why: "the pitch named" },
  { text: "@Match Time sahamız Goals Sutton", last: null, want: "venue:Goals Sutton", why: "TR: the pitch named" },
  { text: "@Match Time we play at Powerleague Shoreditch now", last: null, want: "venue:Powerleague Shoreditch", why: "we play at" },
  { text: "@Match Time artık Powerleague Shoreditch'te oynuyoruz", last: null, want: "venue:Powerleague Shoreditch", why: "TR: case ending dropped" },
  { text: "@Match Time 2", last: LIST, want: "venue:Goals Sutton#2", why: "a pick from MatchTime's list" },
  { text: "@Match Time ikincisi", last: LIST_TR, want: "venue:Goals Sutton#2", why: "TR: the second one" },
  { text: "@Match Time where is the game?", last: null, want: "not-new", why: "a question, not setting it" },
  { text: "@Match Time thanks", last: REFUSED, want: "not-new", why: "thanks after a refusal is not a retry" },
  { text: "the pitch at Goals was flooded", last: null, want: "not-new", why: "talk about a pitch" },
  { text: "@Match Time our pitch is Goals Sutton", last: null, want: "venue:Goals Sutton", why: "HQ: the pitch named", hq: true },
  { text: "@Match Time added the venue location", last: REFUSED, want: "retry", why: "HQ: the live case", hq: true },
  { text: "@Match Time şimdi dene", last: REFUSED_TR, want: "retry", why: "HQ TR: try now", hq: true },
];

const ASK_BEFORE = "@Match Time ask the player pool and partner clubs for extra players for the next match";

/**
 * THE FOLLOW-UP PATH (`group-admin-followups.ts`), read before the router:
 * a tagged message within 15 minutes of the organisers' stored ask is read
 * with NO context (the refusal's words are not stored), and a pick from
 * MatchTime's list with the list as MatchTime's last post. The router is
 * not asked: this path does not depend on it.
 */
const FOLLOWUPS: Case[] = [
  { text: "@Match Time added the venue location", last: null, want: "retry", why: "follow-up: THE LIVE CASE, no context" },
  { text: "@Match Time tamam ekledim", last: null, want: "retry", why: "follow-up TR: no context" },
  { text: "@Match Time done, try again", last: null, want: "retry", why: "follow-up: no context" },
  { text: "@Match Time şimdi dene", last: null, want: "retry", why: "follow-up TR: no context" },
  { text: "@Match Time our pitch is Goals Sutton", last: null, want: "venue:Goals Sutton", why: "follow-up: the pitch named after the refusal" },
  { text: "@Match Time Naim is out", last: null, want: "not-new", why: "follow-up window: a squad change is not a retry" },
  { text: "@Match Time how many are in?", last: null, want: "not-new", why: "follow-up window: a question is not a retry" },
  { text: "@Match Time 2", last: LIST, want: "venue:Goals Sutton#2", why: "follow-up: a pick from the list" },
  { text: "@Match Time ikincisi", last: LIST_TR, want: "venue:Goals Sutton#2", why: "follow-up TR: a pick from the list" },
];

async function followupCase(i: number, c: Case): Promise<boolean> {
  const id = `f${i}`;
  const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Kemal", tagged: true, history: [], lastBotPost: c.last, now: NOW });
  const f = ex.facts.kind === "admin" ? ex.facts : null;
  const g = got(f);
  const ok = matches(c.want, g);
  console.log(`${ok ? "PASS" : "FAIL"}  FOLLOW-UP ${JSON.stringify(c.text)}  extractor ${g}   (${c.why}; want ${c.want})`);
  return ok;
}

async function runCase(i: number, c: Case): Promise<{ extractorOk: boolean; reached: boolean }> {
  const id = `c${i}`;
  const history = c.last ? [{ author: "Kemal", body: ASK_BEFORE }, { author: "MatchTime", body: c.last }] : [];
  const r = await routeBatch(
    model,
    [
      {
        id,
        authorName: "Kemal",
        body: c.text,
        ...(c.hq
          ? { organisers: { context: organisersContext({ pending: [], recent: c.last ? [{ fromMatchTime: false, text: ASK_BEFORE }, { fromMatchTime: true, text: c.last }] : [] }), senderIsOrganiser: true } }
          : {}),
      },
    ],
    { floor: true },
  );
  const route = r.routes[0]?.route ?? null;
  const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Kemal", tagged: /@match\s*time/i.test(c.text), history, lastBotPost: c.last, now: NOW });
  const f = ex.facts.kind === "admin" ? ex.facts : null;
  const g = got(f);
  const extractorOk = matches(c.want, g);
  // Where the admin extractor is read: admin_ops in both places, ask_group in HQ too.
  const readsAdmin = route === "admin_ops" || (c.hq === true && route === "ask_group");
  const reached = c.want === "not-new" ? true : readsAdmin;
  console.log(`${extractorOk && reached ? "PASS" : "FAIL"}  ${c.hq ? "HQ" : "PG"} ${JSON.stringify(c.text)}  routed ${route}  extractor ${g}${f?.toMatchTime ? " toMatchTime" : ""}   (${c.why}; want ${c.want}${!reached ? "; ROUTER MISS" : ""}${!extractorOk ? "; EXTRACTOR MISS" : ""})`);
  return { extractorOk, reached };
}

async function main() {
  if (process.env.MEASURE) {
    await runCase(0, CASES[0]);
    console.log(`\nMEASURED: ${calls} calls, $${usd.toFixed(5)} (dev key).`);
    return;
  }
  let pass = 0, exMiss = 0, routeMiss = 0;
  const only = process.env.ONLY;
  for (const [i, c] of FOLLOWUPS.entries()) {
    if (only && !c.text.includes(only)) continue;
    if (await followupCase(i, c)) pass++;
    else exMiss++;
  }
  if (process.env.FOLLOWUPS_ONLY) {
    console.log(`\n${pass} passed; extractor misses ${exMiss}. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
    process.exit(exMiss > 0 ? 1 : 0);
  }
  for (const [i, c] of CASES.entries()) {
    if (only && !c.text.includes(only)) continue;
    const r = await runCase(i, c);
    if (r.extractorOk && r.reached) pass++;
    if (!r.extractorOk) exMiss++;
    if (!r.reached) routeMiss++;
  }
  console.log(`\n${pass} passed; extractor misses ${exMiss}; router misses ${routeMiss}. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(exMiss > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
