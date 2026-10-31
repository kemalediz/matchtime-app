/**
 * LIVE CHECK: help asked in any words, through the router AND the question
 * extractor, each case ONCE (2026-10-28).
 *
 * The regex help reader is gone: in the players' group and in HQ a help
 * question now reaches its answer only if the shared router sends it to
 * `question` (or HQ's `help`) and the question extractor reads
 * `how_it_works` with the right topic. The router prompt is unchanged; this
 * checks the new wordings route where they must, then reads each routed
 * message with the shipped extractor (the DM path is the extractor alone,
 * covered by `live-check-question-extractor.ts`).
 *
 * Spends ANTHROPIC_API_KEY_DEV only. Stops at $1. Prints calls and cost.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-help-routing.ts
 */
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { HelpFeature, Route } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("the help routing live check");

const MAX_USD = 1;
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

interface Case {
  text: string;
  hq?: boolean;
  /** The help topic; null is the menu. */
  feature: HelpFeature | null;
  badge?: string;
}

const CASES: Case[] = [
  // The players' group, tagged.
  { text: "@Match Time help", feature: null },
  { text: "@Match Time yardım", feature: null },
  { text: "@Match Time what can you do?", feature: null },
  { text: "@Match Time how do I turn on the player pool?", feature: "pool" },
  { text: "@Match Time havuz nasıl açılır", feature: "pool" },
  { text: "@Match Time can I play for other teams near me too?", feature: "pool" },
  { text: "@Match Time how do partner clubs work?", feature: "partners" },
  { text: "@Match Time where are the settings?", feature: "settings" },
  { text: "@Match Time help ratings", feature: "ratings" },
  { text: "@Match Time yardım ödeme", feature: "payments" },
  { text: "@Match Time help badges Mr Reliable", feature: "badges", badge: "reliable" },
  { text: "@Match Time how do I switch off man of the match?", feature: "mom" },
  { text: "@Match Time how do I cancel next week?", feature: "schedule" },
  { text: "@Match Time how do I bring a friend?", feature: "friend" },
  // HQ, untagged, as organisers write there.
  { text: "what can you do?", hq: true, feature: null },
  { text: "how does the player pool work?", hq: true, feature: "pool" },
  { text: "havuzu nasıl açarız", hq: true, feature: "pool" },
  { text: "how do we get players from partner clubs?", hq: true, feature: "partners" },
  { text: "where do I change the reminders?", hq: true, feature: "reminders" },
  { text: "ayarlar nerede?", hq: true, feature: "settings" },
];

async function main() {
  const results: Array<Record<string, unknown>> = [];
  let ok = 0;
  for (const [i, c] of CASES.entries()) {
    const context = organisersContext({ pending: [], recent: [] });
    const routed = await routeBatch(
      model,
      [{ id: `c${i}`, authorName: c.hq ? "Hamzah" : "Can", body: c.text, ...(c.hq ? { organisers: { context } } : {}) }],
      { floor: false, awaiting: null },
    );
    const route = routed.routes[0]?.route as Route | undefined;
    const routeOk = route === "question" || (c.hq && route === "help");
    let got: Record<string, unknown> | null = null;
    let pass = false;
    if (routeOk) {
      const ex = await extractForRoute(model, "question", {
        id: `c${i}`,
        body: c.text,
        authorName: c.hq ? "Hamzah" : "Can",
        tagged: true,
        history: [],
        lastBotPost: null,
        now: new Date(),
      });
      const f = ex.facts.kind === "question" ? ex.facts : null;
      got = f && { topic: f.topic, feature: f.feature ?? null, badge: f.badge ?? null };
      pass = !!f && f.topic === "how_it_works" && (f.feature ?? null) === c.feature && (!c.badge || f.badge === c.badge);
    }
    if (pass) ok++;
    results.push({ text: c.text, group: c.hq ? "organisers" : "players", route, got, want: { feature: c.feature, badge: c.badge ?? null }, pass });
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.hq ? "HQ " : "PG "} ${JSON.stringify(c.text)}  route ${route}  ${JSON.stringify(got)}  (want ${c.feature ?? "menu"}${c.badge ? `, ${c.badge}` : ""})`);
  }
  console.log(`\n${ok}/${CASES.length} passed. Calls ${calls}, cost $${usd.toFixed(5)} (dev key).`);
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ results, calls, usd }, null, 2));
  process.exit(ok === CASES.length ? 0 : 1);
}

void main();
