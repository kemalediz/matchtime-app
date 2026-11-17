/**
 * "KEEP THEM APART": THE PAID CHECK FOR THE TEAMS PROMPT REWRITE (2026-11-16).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * The Vets, 16 Nov 2026: "@Match Time generate the teams, put Dan and Craig
 * in separate teams please", twice. The teams extractor could say "together"
 * (pairings) but had no field for "apart", so it returned a plain generate
 * and the request was silently ignored. The prompt now has `apart`, defined
 * once beside `pairings`, with EN and TR examples.
 *
 * Each case ONCE, made-up names only:
 *   1. the router on the apart phrasings (unchanged prompt; checks they
 *      still reach the balancer route);
 *   2. the teams extractor on the new apart phrasings, EN and TR, and on the
 *      behaviours it already had: generate, swap, together, colour swap;
 *   3. the incident end to end: the live router, the live extractor, then
 *      the real balancer over a made-up squad and the reply the group would
 *      get (no database, sends nothing).
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-teams-apart-2026-11-16.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Stops at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { balanceTeams } from "../src/lib/team-balancer.ts";
import { constraintLines } from "../src/lib/team-constraints.ts";
import type { TeamFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = 1;

spendDevApiKeyOrExit("the teams apart live check");

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: inner.name,
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

const NOW = new Date("2026-11-16T18:00:00Z");
const INCIDENT = "@Match Time generate the teams, put Dan and Craig in separate teams please";

interface Want {
  action: string;
  apart?: string[][];
  pairings?: string[][];
  moves?: string[];
  swapSides?: boolean;
}
interface Case {
  text: string;
  want: Want;
  why: string;
}

const CASES: Case[] = [
  { text: INCIDENT, want: { action: "generate", apart: [["Dan", "Craig"]] }, why: "THE INCIDENT" },
  { text: "@Match Time regenerate the teams, Dan and Craig shouldn't be on the same side", want: { action: "generate", apart: [["Dan", "Craig"]] }, why: "apart, rebuild" },
  { text: "@Match Time takımları kur, Dan ile Craig ayrı takımlarda oynasın", want: { action: "generate", apart: [["Dan", "Craig"]] }, why: "apart, new teams, TR" },
  { text: "@Match Time keep Dan and Craig apart", want: { action: "swap", apart: [["Dan", "Craig"]] }, why: "apart, teams as they stand" },
  { text: "@Match Time can you split Dan and Craig up please, they always end up together", want: { action: "swap", apart: [["Dan", "Craig"]] }, why: "apart, other words" },
  { text: "@Match Time Dan ile Craig'i farklı takımlara koy", want: { action: "swap", apart: [["Dan", "Craig"]] }, why: "apart, teams as they stand, TR" },
  { text: "@Match Time make the teams, me and Craig on the same team and keep Dan away from Tom", want: { action: "generate", pairings: [["me", "Craig"]], apart: [["Dan", "Tom"]] }, why: "together and apart in one" },
  { text: "@Match Time generate the teams", want: { action: "generate", apart: [], pairings: [] }, why: "plain generate (existing)" },
  { text: "@Match Time takımları yeniden kur", want: { action: "generate", apart: [], pairings: [] }, why: "plain rebuild, TR (existing)" },
  { text: "@Match Time swap Dan and Sam", want: { action: "swap", moves: ["Dan", "Sam"], apart: [] }, why: "two-player swap (existing)" },
  { text: "@Match Time put Ali and Habib on the same team", want: { action: "swap", pairings: [["Ali", "Habib"]], apart: [] }, why: "together (existing)" },
  { text: "@Match Time swap the colours", want: { action: "swap", swapSides: true, apart: [] }, why: "colour swap (existing)" },
];

const norm = (gs: string[][] | undefined) => (gs ?? []).map((g) => g.map((n) => n.toLowerCase()).sort().join("+")).sort().join(" | ");
const same = (a: string[][] | undefined, b: string[][] | undefined) => norm(a) === norm(b);

async function routeOne(text: string, i: number) {
  const r = await routeBatch(model, [{ id: `r${i}`, authorName: "Oscar Owner", body: text }], { floor: false, awaiting: null });
  return r.routes[0]?.route ?? "missing";
}

async function extractOne(text: string, i: number): Promise<TeamFacts | string> {
  const ex = await extractForRoute(model, "balancer", {
    id: `t${i}`,
    body: text,
    authorName: "Oscar Owner",
    tagged: true,
    history: [],
    lastBotPost: null,
    reply: null,
    now: NOW,
  });
  return ex.facts.kind === "teams" ? ex.facts : `(${ex.facts.kind})`;
}

async function main() {
  const rows: string[] = [];

  console.log(`\n== 1. Router on the apart phrasings: ${CASES.slice(0, 7).length} cases x 1 ==\n`);
  let rok = 0;
  for (const [i, c] of CASES.slice(0, 7).entries()) {
    const got = await routeOne(c.text, i);
    const pass = got === "balancer";
    if (pass) rok++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)} -> ${got}`);
  }
  console.log(`-- router: ${rok}/7`);

  console.log(`\n== 2. Teams extractor: ${CASES.length} cases x 1 ==\n`);
  let eok = 0;
  for (const [i, c] of CASES.entries()) {
    const f = await extractOne(c.text, i);
    if (typeof f === "string") {
      rows.push(`| ${i + 1} | ${c.why} | ${c.want.action} | ${f} | FAIL |`);
      console.log(`FAIL  ${JSON.stringify(c.text)} -> ${f}`);
      continue;
    }
    const checks = [
      f.action === c.want.action,
      c.want.apart === undefined || same(f.apart, c.want.apart),
      c.want.pairings === undefined || same(f.pairings, c.want.pairings),
      c.want.moves === undefined || JSON.stringify(f.moves ?? []) === JSON.stringify(c.want.moves),
      c.want.swapSides === undefined || f.swapSides === c.want.swapSides,
    ];
    const pass = checks.every(Boolean);
    if (pass) eok++;
    const got = `${f.action}${f.apart?.length ? ` apart ${JSON.stringify(f.apart)}` : ""}${f.pairings.length ? ` pairings ${JSON.stringify(f.pairings)}` : ""}${f.moves?.length ? ` moves ${JSON.stringify(f.moves)}` : ""}${f.swapSides ? " swapSides" : ""}`;
    rows.push(`| ${i + 1} | ${c.why} | \`${c.text.replace("@Match Time ", "")}\` | ${got} | ${pass ? "PASS" : "FAIL"} |`);
    console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)} -> ${got}   (${c.why})`);
  }
  console.log(`-- teams extractor: ${eok}/${CASES.length}`);

  console.log(`\n== 3. The incident end to end (live router, live extractor, real balancer, made-up squad) ==\n`);
  const route = await routeOne(INCIDENT, 99);
  console.log(`router: ${route}`);
  const f = await extractOne(INCIDENT, 99);
  if (typeof f !== "string") {
    // Dan and Craig the two strongest of ten, made-up ratings: a plain draft
    // splits them anyway, so Craig is made the weakest to make it bite.
    const names = ["Dan", "Craig", "Eli", "Finn", "Gus", "Hal", "Ivo", "Jon", "Abe", "Bob"];
    const rating: Record<string, number> = { Dan: 9, Craig: 3, Eli: 6, Finn: 6, Gus: 6, Hal: 6, Ivo: 6, Jon: 6, Abe: 6, Bob: 6 };
    const players = names.map((n) => ({ id: n, name: n, positions: [], rating: rating[n] }));
    const plain = balanceTeams({ players, perTeam: 5, strategy: "rating-only" });
    const plainSame = plain.red.some((p) => p.id === "Dan") === plain.red.some((p) => p.id === "Craig");
    const apart = (f.apart ?? []).map((g) => g.map((n) => names.find((x) => x.toLowerCase() === n.toLowerCase()) ?? n));
    const r = balanceTeams({ players, perTeam: 5, strategy: "rating-only", apart });
    const split = r.red.some((p) => p.id === "Dan") !== r.red.some((p) => p.id === "Craig");
    const lines = constraintLines({ together: [], apart: apart.map((g) => g.map((n) => ({ userId: n, name: n }))), unmet: r.unmet, lang: "en" });
    console.log(`extractor: ${f.action} apart ${JSON.stringify(f.apart)}`);
    console.log(`plain draft puts them on one side: ${plainSame}; with apart, split: ${split}`);
    console.log(`reply lead: ${lines.join(" / ")}`);
    console.log(`Red: ${r.red.map((p) => p.name).join(", ")} | Yellow: ${r.yellow.map((p) => p.name).join(", ")}`);
  }

  console.log(`\n| # | case | message | extracted | result |\n|---|---|---|---|---|\n${rows.join("\n")}`);
  console.log(`\nmodel calls: ${calls}, cost: $${usd.toFixed(4)} (cap $${MAX_USD})`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nmodel calls: ${calls}, cost: $${usd.toFixed(4)}`);
  process.exit(1);
});
