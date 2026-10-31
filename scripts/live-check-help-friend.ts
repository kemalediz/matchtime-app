/**
 * LIVE CHECK: "help friend", each case ONCE (2026-10-31).
 *
 * The friend link (#488) got its own help topic: the question extractor's
 * `feature` gained `friend`. This runs the SHIPPED router and question
 * extractor on the new wordings, in the players' group and HQ (router, then
 * the extractor on what it routed `question` or HQ's `help`) and by DM (the
 * extractor alone, as `readDmHelp` does), plus near misses that must NOT
 * read as the friend topic: a friend said to be playing (attendance, never
 * help), bare help, paying, and "help availability".
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Stops at $1.
 * Prints calls and cost. ZERO WRITES: no database client is imported.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-help-friend.ts
 */
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { HelpFeature, Route } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("the help friend live check");

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

type Door = "group" | "hq" | "dm";
interface Case {
  id: string;
  door: Door;
  text: string;
  /** A help topic the answer must name (null: the menu). */
  feature?: HelpFeature | null;
  /** A near miss: anything but the friend topic passes, and a group
   *  message about a friend playing must not route to question at all. */
  notFriend?: boolean;
  /** For a near miss in the group: the router must send it to one of these. */
  routes?: Route[];
}

const ATTENDANCE: Route[] = ["self_att", "other_att", "offer", "unsure"];

const CASES: Case[] = [
  // The friend topic, every door, English and Turkish.
  { id: "F1", door: "group", text: "@Match Time help friend", feature: "friend" },
  { id: "F2", door: "group", text: "@Match Time how do I bring a friend?", feature: "friend" },
  { id: "F3", door: "group", text: "@Match Time arkadaşımı nasıl getiririm?", feature: "friend" },
  { id: "F4", door: "group", text: "@Match Time yardım arkadaş", feature: "friend" },
  { id: "F5", door: "hq", text: "@Match Time how does the friend link work?", feature: "friend" },
  { id: "F6", door: "hq", text: "@Match Time oyuncular arkadaşlarını maça nasıl getiriyor?", feature: "friend" },
  { id: "F7", door: "dm", text: "help friend", feature: "friend" },
  { id: "F8", door: "dm", text: "how do I bring a friend?", feature: "friend" },
  { id: "F9", door: "dm", text: "arkadaşımı nasıl getiririm?", feature: "friend" },
  { id: "F10", door: "dm", text: "my mate wants to play one week, how does he join?", feature: "friend" },
  // Near misses: must not be the friend topic.
  { id: "X1", door: "group", text: "my friend Ali is in", notFriend: true, routes: ATTENDANCE },
  { id: "X2", door: "group", text: "arkadaşım Ali de geliyor", notFriend: true, routes: ATTENDANCE },
  { id: "X3", door: "group", text: "@Match Time help", feature: null },
  { id: "X4", door: "group", text: "@Match Time how do I pay?", feature: "payments" },
  { id: "X5", door: "group", text: "@Match Time help availability", feature: "availability" },
  { id: "X6", door: "dm", text: "my friend Ali is coming on Friday", notFriend: true },
  { id: "X7", door: "dm", text: "help", feature: null },
];

async function main() {
  const only = process.env.ONLY?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  const results: Array<Record<string, unknown>> = [];
  let ok = 0;
  for (const c of cases) {
    const hq = c.door === "hq";
    const author = hq ? "Hamzah" : "Can";
    let route: Route | "dm" = "dm";
    if (c.door !== "dm") {
      const context = organisersContext({ pending: [], recent: [] });
      const routed = await routeBatch(
        model,
        [{ id: c.id, authorName: author, body: c.text, ...(hq ? { organisers: { context } } : {}) }],
        { floor: false, awaiting: null },
      );
      route = (routed.routes[0]?.route as Route | undefined) ?? ("none" as Route);
    }
    const reachesQuestion = route === "dm" || route === "question" || (hq && route === "help");
    let got: Record<string, unknown> | null = null;
    if (reachesQuestion) {
      const ex = await extractForRoute(model, "question", {
        id: c.id,
        body: c.text,
        authorName: author,
        tagged: true,
        history: [],
        lastBotPost: null,
        now: new Date(),
      });
      const f = ex.facts.kind === "question" ? ex.facts : null;
      got = f ? { topic: f.topic, feature: f.feature ?? null } : { degraded: ex.degradations.map((d) => d.detail) };
    }
    let pass: boolean;
    if (c.notFriend) {
      const friend = got?.topic === "how_it_works" && got?.feature === "friend";
      const routeOk = !c.routes || (route !== "dm" && c.routes.includes(route));
      pass = !friend && routeOk;
    } else {
      pass = reachesQuestion && got?.topic === "how_it_works" && (got?.feature ?? null) === c.feature;
    }
    if (pass) ok++;
    results.push({ id: c.id, door: c.door, text: c.text, route, got, want: c.notFriend ? "not friend" : (c.feature ?? "menu"), pass });
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${c.id.padEnd(4)} ${c.door.padEnd(5)} ${JSON.stringify(c.text)}  route ${route}  ${JSON.stringify(got)}  (want ${c.notFriend ? `not friend${c.routes ? `, route ${c.routes.join("|")}` : ""}` : (c.feature ?? "menu")})`,
    );
  }
  console.log(`\n${ok}/${cases.length} passed. Calls ${calls}, cost $${usd.toFixed(5)} (dev key).`);
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ results, calls, usd }, null, 2));
  process.exit(ok === cases.length ? 0 : 1);
}

void main();
