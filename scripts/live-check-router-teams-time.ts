/**
 * ASKING WHEN THE TEAMS COME OUT IS A QUESTION: THE PAID CHECK (2026-10-20).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * Measured on main (dev key, Haiku 5.5): "@Match Time when will the teams
 * be out?" in the players' group routed `balancer` 2 times in 10 instead of
 * `question`, and "MatchTime yöneticiler kim?" in the organisers' group
 * routed `none` 1 to 2 times in 10. A question about the teams routed to
 * `balancer` reaches the teams extractor, whose actions are show, generate,
 * rename and swap; this check also asks that extractor what it reads a
 * when-question as, because `generate` there rewrites the line-ups.
 *
 * The boundary: asking WHEN (or whether yet) the teams come is `question`;
 * asking to SEE or MAKE them is `balancer`.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-router-teams-time.ts
 *
 *   REPEAT=10 (default) for the two incidents; BOUNDARY_REPEAT=3 for the
 *   boundary set; EXTRACT_REPEAT=3 for the teams extractor; JSON=<path>
 *   writes every result; ONLY="a|b" runs just those texts.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD.
 */
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 4;

spendDevApiKeyOrExit("the router teams-time live check");

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
  want: Route[];
  why: string;
}

const INCIDENTS: Case[] = [
  { text: "@Match Time when will the teams be out?", want: ["question"], why: "players' group, the incident" },
  { text: "MatchTime yöneticiler kim?", hq: true, want: ["question", "help"], why: "HQ, the incident" },
  { text: "@Match Time takımlar ne zaman?", want: ["question"], why: "players' group, when, TR (1 of 3 on main)" },
];

const BOUNDARY: Case[] = [
  // WHEN the teams come: question.
  { text: "@Match Time when are teams announced", want: ["question"], why: "when, no question mark" },
  { text: "@Match Time what time do the teams come out?", want: ["question"], why: "when (an example in the new prompt)" },
  { text: "@Match Time takımlar ne zaman belli olur?", want: ["question"], why: "when, TR" },
  { text: "@Match Time what time will you post the teams?", want: ["question"], why: "when, held out" },
  { text: "@Match Time takımları ne zaman atacaksın?", want: ["question"], why: "when, TR, held out" },
  { text: "@Match Time are the teams out yet?", want: ["question", "balancer"], why: "whether yet: either owner answers it, never none" },
  { text: "@Match Time are the teams done", want: ["question", "balancer"], why: "whether yet: either owner answers it, never none" },
  { text: "@Match Time how are the teams picked?", want: ["question"], why: "HOW the teams are made stays question" },
  // SEE or MAKE them: balancer.
  { text: "@Match Time teams?", want: ["balancer"], why: "a bare teams asks to see them" },
  { text: "Teams?", want: ["balancer"], why: "the prompt's own example" },
  { text: "@Match Time show the teams", want: ["balancer"], why: "show" },
  { text: "@Match Time takımları göster", want: ["balancer"], why: "show, TR" },
  { text: "@Match Time generate the teams", want: ["balancer"], why: "make" },
  { text: "@Match Time takımları kur", want: ["balancer"], why: "make, TR" },
  { text: "@Match Time regenerate the teams once more", want: ["balancer"], why: "the prompt's own example" },
  // HQ.
  { text: "MatchTime who are the admins?", hq: true, want: ["question", "help"], why: "HQ, EN" },
  { text: "MatchTime when are the teams made?", hq: true, want: ["question", "help"], why: "HQ, the teams time" },
  { text: "MatchTime takımlar ne zaman kuruluyor?", hq: true, want: ["question", "help"], why: "HQ, the teams time, TR" },
  { text: "teams", hq: true, want: ["balancer"], why: "HQ, a bare teams is balancer" },
  { text: "send us the team sheet image", hq: true, want: ["team_sheet"], why: "HQ, team sheet" },
  { text: "the teams look a bit uneven, what do you reckon?", hq: true, want: ["none"], why: "HQ, organisers talking" },
  { text: "who's doing the teams this week?", hq: true, want: ["none"], why: "HQ, untagged question to the other organisers" },
  { text: "who's on the bench?", hq: true, want: ["question", "help"], why: "HQ, untagged question the bot holds (failed once on main in hq-questions)" },
];

/** The teams extractor on WHEN-questions: it must never say generate. */
const EXTRACT: string[] = [
  "@Match Time when will the teams be out?",
  "@Match Time takımlar ne zaman?",
  "@Match Time when are teams announced",
  "@Match Time are the teams done",
  "@Match Time are the teams out yet?",
];

const results: Array<Record<string, unknown>> = [];

async function routeOnce(c: Case, i: number): Promise<Route | undefined> {
  const context = organisersContext({ pending: [], recent: [] });
  const r = await routeBatch(
    model,
    [{ id: `c${i}`, authorName: c.hq ? "Hamzah" : "Can", body: c.text, ...(c.hq ? { organisers: { context } } : {}) }],
    { floor: c.hq ? true : false, awaiting: null },
  );
  return r.routes[0]?.route;
}

async function runSet(label: string, all: Case[], repeat: number) {
  // ONLY="a|b": just the cases whose text is one of those.
  const only = process.env.ONLY?.split("|");
  const cases = only ? all.filter((c) => only.includes(c.text)) : all;
  console.log(`\n== ${label}: ${cases.length} cases x ${repeat} ==\n`);
  let ok = 0;
  let total = 0;
  for (const [i, c] of cases.entries()) {
    const got: Record<string, number> = {};
    let pass = 0;
    for (let k = 0; k < repeat; k++) {
      const route = (await routeOnce(c, i)) ?? "missing";
      got[route] = (got[route] ?? 0) + 1;
      if (c.want.includes(route as Route)) pass++;
    }
    ok += pass;
    total += repeat;
    results.push({ set: label, text: c.text, group: c.hq ? "organisers" : "players", want: c.want, pass, of: repeat, routes: got });
    console.log(`${pass === repeat ? "PASS" : "FAIL"} ${pass}/${repeat}  ${JSON.stringify(c.text)}  ${JSON.stringify(got)}   (${c.why}; want ${c.want.join("|")})`);
  }
  console.log(`-- ${label}: ${ok}/${total}`);
}

async function main() {
  const repeat = Number(process.env.REPEAT ?? 10);
  const boundaryRepeat = Number(process.env.BOUNDARY_REPEAT ?? 3);
  const extractRepeat = Number(process.env.EXTRACT_REPEAT ?? 3);
  if (repeat > 0) await runSet("incidents", INCIDENTS, repeat);
  if (boundaryRepeat > 0) await runSet("boundary", BOUNDARY, boundaryRepeat);

  if (extractRepeat > 0) {
    console.log(`\n== Teams extractor on when-questions: ${EXTRACT.length} x ${extractRepeat} (must never be generate) ==\n`);
    for (const [i, text] of EXTRACT.entries()) {
      const got: Record<string, number> = {};
      for (let k = 0; k < extractRepeat; k++) {
        const ex = await extractForRoute(model, "balancer", { id: `t${i}`, body: text, authorName: "Can", tagged: true, history: [], lastBotPost: null });
        const a = ex.facts.kind === "teams" ? ex.facts.action : `(${ex.facts.kind})`;
        got[a] = (got[a] ?? 0) + 1;
      }
      results.push({ set: "teams-extractor", text, actions: got });
      console.log(`${got.generate ? "GENERATE" : "ok      "}  ${JSON.stringify(text)}  ${JSON.stringify(got)}`);
    }
  }

  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ calls, usd, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
