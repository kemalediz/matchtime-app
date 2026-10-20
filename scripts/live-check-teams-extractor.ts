/**
 * LIVE CHECK: the teams extractor, each case ONCE (2026-10-20).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Runs the SHIPPED
 * extractor (`extractForRoute`, its prompt and its `EXTRACTOR_CALLS` model)
 * on messages about the line-ups, English and Turkish, and grades the facts:
 * the action, the names the message gives or asks MatchTime to make up, and
 * who moves where. It includes T5, the self-contradictory message that made
 * Sonnet 5's adaptive thinking spend the whole budget and return no text
 * (2026-09-06, `__tests__/thinking-off.test.ts`), so a model or thinking
 * change shows whether that runaway comes back.
 *
 * ZERO WRITES: no database client is imported.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-teams-extractor.ts
 *   ONLY=T5,S1 node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-teams-extractor.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import type { TeamFacts } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("scripts/live-check-teams-extractor.ts");

const MAX_USD = 1;
let calls = 0;
let usd = 0;
const ms: number[] = [];
const inner = anthropicModel();
const model: PipelineModel = {
  name: inner.name,
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    ms.push(r.ms);
    return r;
  },
};

interface Case {
  id: string;
  body: string;
  /** The action, or a list of acceptable ones. */
  action: TeamFacts["action"] | Array<TeamFacts["action"]>;
  /** "invented": two distinct names that are not Red or Yellow. */
  names?: "none" | "invented" | [string, string];
  includes?: string[];
  moves?: string[];
  swaps?: Array<{ personRef: string; team: "RED" | "YELLOW" }>;
  pairings?: string[][];
}

const CASES: Case[] = [
  { id: "T5", body: "@Match Time show us the teams again without regenerating replacing Ehtisham with Najib", action: ["show", "swap"] },
  { id: "T5b", body: "@Match Time keep the same teams but regenerate them with Ali on red", action: ["generate", "swap", "show"] },
  { id: "S1", body: "@Match Time generate the teams — you pick some fun team names for us this week", action: "generate", names: "invented" },
  { id: "S1b", body: "@Match Time generate the teams now, come up with fun team names", action: "generate", names: "invented" },
  { id: "S1tr", body: "@Match Time takımları kur, takımlara güzel isimler bul", action: "generate", names: "invented" },
  { id: "G1", body: "@Match Time generate the teams", action: "generate", names: "none" },
  { id: "G2", body: "@Match Time generate the teams, Ibrahim is playing", action: "generate", names: "none", includes: ["Ibrahim"] },
  { id: "G3", body: "@Match Time make the teams, me and David on the same team", action: "generate", pairings: [["me", "David"]] },
  { id: "G4", body: "@Match Time regenerate and call them Lions and Tigers", action: "generate", names: ["Lions", "Tigers"] },
  { id: "G5", body: "@Match Time yeniden kur", action: "generate", names: "none" },
  { id: "R1", body: "@Match Time call the teams Lions and Tigers", action: "rename", names: ["Lions", "Tigers"] },
  { id: "R2", body: "@Match Time takımların adı Aslanlar ve Kaplanlar olsun", action: "rename", names: ["Aslanlar", "Kaplanlar"] },
  { id: "V1", body: "@Match Time show the teams", action: "show", names: "none" },
  { id: "V2", body: "@Match Time takımları göster", action: "show", names: "none" },
  { id: "W1", body: "@Match Time put David in Red", action: "swap", swaps: [{ personRef: "David", team: "RED" }] },
  { id: "W2", body: "@Match Time swap Ali and Can", action: "swap", moves: ["Ali", "Can"] },
  { id: "W3", body: "@Match Time Tom'u diğer takıma al", action: "swap", moves: ["Tom"] },
];

const lc = (a: string[]) => a.map((s) => s.toLowerCase()).sort();
const same = (a: string[], b: string[]) => JSON.stringify(lc(a)) === JSON.stringify(lc(b));

function grade(c: Case, f: TeamFacts): string[] {
  const bad: string[] = [];
  const actions = Array.isArray(c.action) ? c.action : [c.action];
  if (!actions.includes(f.action)) bad.push(`action ${f.action}, want ${actions.join("|")}`);
  if (c.names === "none" && f.teamNames) bad.push(`names ${JSON.stringify(f.teamNames)}, want none`);
  if (c.names === "invented") {
    const n = f.teamNames;
    if (!n) bad.push("no names, want two made up");
    else if (n[0].toLowerCase() === n[1].toLowerCase() || n.some((x) => /^(red|yellow)s?$/i.test(x.trim()) || x.length > 24))
      bad.push(`names ${JSON.stringify(n)} are not two distinct new names`);
  }
  if (Array.isArray(c.names) && !(f.teamNames && same(f.teamNames, c.names))) bad.push(`names ${JSON.stringify(f.teamNames)}, want ${JSON.stringify(c.names)}`);
  if (c.includes && !same(f.includeRefs, c.includes)) bad.push(`includeRefs ${JSON.stringify(f.includeRefs)}`);
  if (c.moves && !same(f.moves ?? [], c.moves)) bad.push(`moves ${JSON.stringify(f.moves)}`);
  if (c.swaps && JSON.stringify(f.swaps.map((s) => [s.personRef.toLowerCase(), s.team])) !== JSON.stringify(c.swaps.map((s) => [s.personRef.toLowerCase(), s.team])))
    bad.push(`swaps ${JSON.stringify(f.swaps)}`);
  if (c.pairings && !(f.pairings.length === c.pairings.length && f.pairings.every((g, i) => same(g, c.pairings![i]))))
    bad.push(`pairings ${JSON.stringify(f.pairings)}`);
  return bad;
}

async function main() {
  const only = process.env.ONLY?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  let failed = 0;
  for (const c of cases) {
    const res = await extractForRoute(model, "balancer", {
      id: c.id,
      body: c.body,
      authorName: "Kemal Ediz",
      tagged: true,
      history: [],
      lastBotPost: null,
    });
    const problems =
      res.facts.kind === "teams" ? grade(c, res.facts) : [`no teams facts: ${res.degradations.map((d) => d.detail).join("; ")}`];
    if (problems.length) failed++;
    console.log(`${problems.length ? "FAIL" : "ok  "} ${c.id.padEnd(5)} ${JSON.stringify(c.body).slice(0, 70).padEnd(72)} ${problems.join("; ")}`);
    console.log(`       facts ${JSON.stringify(res.facts)}`);
  }
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0);
  console.log(
    `\n${cases.length - failed}/${cases.length} cases passed. ${calls} model call(s), $${usd.toFixed(4)}. ` +
      `latency p50 ${at(0.5)} ms, p90 ${at(0.9)} ms.`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
