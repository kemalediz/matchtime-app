/**
 * MINIMUM PLAYERS BY WHATSAPP: THE PAID CHECK (2026-11-03, the Vets play
 * one down; Kemal: every admin feature also works by tagging MatchTime).
 *
 * Each case ONCE through the real router and the real admin extractor, the
 * way production reads it, in the players' group (PG) and the organisers'
 * group (HQ). The extractor is read whatever the route, so a router miss
 * and an extractor miss are told apart.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-min-players.ts
 *   ONLY=<text> ...   the cases whose text contains it
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { AdminFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.3);
spendDevApiKeyOrExit("the minimum players live check");

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

const NOW = new Date("2026-11-03T11:31:00Z");
/** "<n>", "<n>@<day>", "full", "none" (min_players with no number), or "not" (not min_players). */
const got = (f: AdminFacts | null): string =>
  f?.action !== "min_players"
    ? `not(${f?.action ?? "none"})`
    : f.fullTeams
      ? "full"
      : f.minPlayers
        ? `${f.minPlayers}${f.matchDay ? `@${f.matchDay.toLowerCase()}` : ""}`
        : "none";
/** A day is matched loosely: "9@thursday" is met by "9@on thursday". */
const matches = (want: string, g: string) =>
  want === "not" ? g.startsWith("not") : want.includes("@") ? g.split("@")[0] === want.split("@")[0] && g.includes(want.split("@")[1]) : want === g;

interface Case { text: string; where: "PG" | "HQ"; want: string; why: string }
const CASES: Case[] = [
  { text: "@Match Time we can play with 12", where: "PG", want: "12", why: "THE VETS CASE" },
  { text: "@Match Time minimum 12 players", where: "PG", want: "12", why: "minimum" },
  { text: "@Match Time 12 kişiyle de oynarız", where: "PG", want: "12", why: "TR" },
  { text: "@Match Time en az 13 kişi yeter", where: "PG", want: "13", why: "TR minimum" },
  { text: "@Match Time we're happy to play one down, 13 is fine", where: "PG", want: "13", why: "one down" },
  { text: "@Match Time back to full teams", where: "PG", want: "full", why: "undo" },
  { text: "@Match Time yine tam takım oynayalım", where: "PG", want: "full", why: "TR undo" },
  { text: "@Match Time how many do we need?", where: "PG", want: "not", why: "a question" },
  { text: "we're 12 tonight lads", where: "PG", want: "not", why: "a count, untagged" },
  { text: "@Match Time bu akşam kaç kişiyiz?", where: "PG", want: "not", why: "TR count question" },
  { text: "@Match Time we can play with 12", where: "HQ", want: "12", why: "HQ: the Vets case" },
  { text: "@Match Time minimum 9 on Thursday", where: "HQ", want: "9@thursday", why: "HQ with a day" },
  { text: "@Match Time perşembe en az 9 kişi", where: "HQ", want: "9@perşembe", why: "HQ TR with a day" },
  { text: "@Match Time back to two full sides", where: "HQ", want: "full", why: "HQ undo" },
];

async function main() {
  let pass = 0, exMiss = 0, routeMiss = 0;
  const only = process.env.ONLY;
  for (const [i, c] of CASES.entries()) {
    if (only && !c.text.includes(only)) continue;
    const id = `c${i}`;
    const r = await routeBatch(
      model,
      [{ id, authorName: "Kemal", body: c.text, ...(c.where === "HQ" ? { organisers: { context: organisersContext({ pending: [], recent: [] }), senderIsOrganiser: true } } : {}) }],
      { floor: true },
    );
    const route = r.routes[0]?.route ?? null;
    const ex = await extractForRoute(model, "admin_ops", { id, body: c.text, authorName: "Kemal", tagged: /@match\s*time/i.test(c.text), history: [], lastBotPost: null, now: NOW });
    const g = got(ex.facts.kind === "admin" ? ex.facts : null);
    const extractorOk = matches(c.want, g);
    const reached = c.want === "not" ? true : route === "admin_ops";
    if (extractorOk && reached) pass++;
    if (!extractorOk) exMiss++;
    if (!reached) routeMiss++;
    console.log(`${extractorOk && reached ? "PASS" : "FAIL"}  ${c.where} ${JSON.stringify(c.text)}  routed ${route}  extractor ${g}   (${c.why}; want ${c.want}${!reached ? "; ROUTER MISS" : ""}${!extractorOk ? "; EXTRACTOR MISS" : ""})`);
  }
  console.log(`\n${pass} passed; extractor misses ${exMiss}; router misses ${routeMiss}. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(exMiss + routeMiss > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
