/**
 * QUIET HOURS BY WHATSAPP: THE PAID CHECK (2026-10-31, MT Test: "@Match
 * Time turn off quiet hours now" was routed admin_ops, read `other` by the
 * admin extractor, and answered "I can't change that by message").
 *
 * Each case ONCE through the real router and the real admin extractor, the
 * way production reads it, in the players' group (PG) and the organisers'
 * group (HQ). The extractor is read whatever the route, so a router miss
 * and an extractor miss are told apart.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-quiet-hours.ts
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
spendDevApiKeyOrExit("the quiet hours live check");

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

const NOW = new Date("2026-10-31T11:31:00Z");
/** "off", "on", "on:<from>-<to>" (either may be empty), or "not" (not quiet_hours). */
const got = (f: AdminFacts | null): string =>
  f?.action !== "quiet_hours" ? `not(${f?.action ?? "none"})` : f.quietOff ? "off" : f.quietFrom || f.quietTo ? `on:${f.quietFrom ?? ""}-${f.quietTo ?? ""}` : "on";
const matches = (want: string, g: string) => (want === "not" ? g.startsWith("not") : want === g);

interface Case { text: string; where: "PG" | "HQ"; want: string; why: string }
const CASES: Case[] = [
  { text: "@Match Time turn off quiet hours now", where: "PG", want: "off", why: "THE LIVE CASE" },
  { text: "@Match Time sessiz saatleri kapat", where: "PG", want: "off", why: "TR off" },
  { text: "@Match Time turn quiet hours back on", where: "PG", want: "on", why: "on" },
  { text: "@Match Time sessiz saatleri aç", where: "PG", want: "on", why: "TR on" },
  { text: "@Match Time quiet from 22:00 to 8am", where: "PG", want: "on:22:00-08:00", why: "times" },
  { text: "@Match Time sessiz saatler gece 11'den sabah 9'a kadar olsun", where: "PG", want: "on:23:00-09:00", why: "TR times" },
  { text: "@Match Time no messages before 7am please", where: "PG", want: "on:-07:00", why: "only the end" },
  { text: "@Match Time are quiet hours on?", where: "PG", want: "not", why: "a question" },
  { text: "the quiet hours held my message again lol", where: "PG", want: "not", why: "talk, untagged" },
  { text: "@Match Time sessiz saatler ne zaman bitiyor?", where: "PG", want: "not", why: "TR question" },
  { text: "@Match Time turn off quiet hours now", where: "HQ", want: "off", why: "HQ: the live case" },
  { text: "@Match Time sessiz saatleri kapat", where: "HQ", want: "off", why: "HQ TR off" },
  { text: "@Match Time quiet hours from 21:30 to 07:00", where: "HQ", want: "on:21:30-07:00", why: "HQ times" },
  { text: "@Match Time sessiz saatleri tekrar aç", where: "HQ", want: "on", why: "HQ TR on" },
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
