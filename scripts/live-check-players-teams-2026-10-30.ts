/**
 * LIVE CHECK (2026-10-30, the "no string parsing" sweep, package P2): the
 * players'-group messages whose regex fast paths were deleted, each ONCE,
 * through what production now runs: the shared router, then for `balancer`
 * the teams extractor (recent chat and MatchTime's last post, the team
 * sheet), and the shape `team-swap-apply.ts` acts on (`playersSwapShape`).
 * What the change then does to the database is pinned by the unit and e2e
 * tests; this checks the model reads the words.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-players-teams-2026-10-30.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { playersSwapShape } from "../src/lib/team-swap-apply.ts";

spendDevApiKeyOrExit("scripts/live-check-players-teams-2026-10-30.ts");

const MAX_USD = 0.1;
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

const RED = ["Kemal Ediz", "Elvin Aliyev", "Sait Demir", "Mustafa Kaya", "Abid Hussain"];
const YELLOW = ["Idris Bello", "Faris Nasser", "Shaz Iqbal", "Adam Osman", "Efat Rahman"];
const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");
const SHEET = `⚽ *Teams for tonight*: Tue 21:30 at Goals Sutton\n\n*Red*:\n${list(RED)}\n\n*Yellow*:\n${list(YELLOW)}`;
const SQUAD_POST = `⚽ *Tue 3 Nov, 21:30* at Goals Sutton\n\n${list([...RED, ...YELLOW])}\n\n4 places left`;
const REPASTE = `Tuesday 21:30 Goals Sutton\n${list([...RED, ...YELLOW])}\n11. Kieran`;

type Verdict = { route: string; action?: string; shape?: string; facts?: string; pastedList?: boolean; teamsSide?: boolean };
interface Case {
  id: string;
  text: string;
  lastBotPost: string;
  want: (v: Verdict) => boolean;
  /** Recorded, not graded: what the pipeline does with a shape it has no action for. */
  record?: boolean;
  why: string;
}

const isSwap = (kind: string) => (v: Verdict) => v.route === "balancer" && v.action === "swap" && v.shape === kind;
const notGenerate = (v: Verdict) => !(v.route === "balancer" && v.action === "generate");

const CASES: Case[] = [
  { id: "T1", text: "@Match Time swap the colours and keep the same teams", lastBotPost: SHEET, want: isSwap("swap-sides"), why: "Kemal 2026-06-09, was the colour regex" },
  { id: "T2", text: "@Match Time renkleri değiştir, takımlar aynı kalsın", lastBotPost: SHEET, want: isSwap("swap-sides"), why: "the Turkish colour swap" },
  { id: "T3", text: "@Match Time swap Elvin with Idris", lastBotPost: SHEET, want: isSwap("two-players"), why: "was parseSwapNames" },
  { id: "T4", text: "@Match Time Elvin ile Idris'i değiştir", lastBotPost: SHEET, want: isSwap("two-players"), why: "the Turkish player swap" },
  { id: "T5", text: "@Match Time do not regenerate the teams. Instead swap Elvin with Raihan and share us the teams", lastBotPost: SHEET, want: isSwap("two-players"), why: "the 2026-09-08 incident message" },
  { id: "T6", text: "@Match Time put me in the same team with these guys in the match 😀", lastBotPost: SHEET, want: notGenerate, why: "the 2026-09-24 joke: never a build (the word gate is gone)" },
  { id: "T7", text: "@Match Time delete these teams, early to form them, there is still 5 days", lastBotPost: SHEET, want: (v) => v.route === "balancer" && v.action === "clear", why: "the clear: the teams extractor's clear action (#476)" },
  { id: "T8", text: "@Match Time generate the teams", lastBotPost: SQUAD_POST, want: (v) => v.route === "balancer" && v.action === "generate", why: "a real build still builds" },
  { id: "T9", text: REPASTE, lastBotPost: SQUAD_POST, want: (v) => v.pastedList === true, why: "a pasted list: the router's pasted_list flag, so the squad reader reads it" },
  { id: "T10", text: "@Match Time swap Elvin with Idris, and I'm out", lastBotPost: SHEET, want: (v) => (v.route === "balancer" ? v.shape === "two-players" : v.teamsSide === true), why: "compound: attendance with a teams side request (both halves), or the swap" },
];

async function main() {
  const only = process.env.ONLY?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  let failed = 0;
  for (const c of cases) {
    const history = [{ author: "MatchTime", body: c.lastBotPost }];
    // FORCE_BALANCER=1 skips the router: what the teams extractor reads when
    // the router sends the message to `balancer` (the router's own rule for a
    // swap in the players' group is not this package's to change).
    const v: Verdict = process.env.FORCE_BALANCER
      ? { route: "balancer" }
      : await (async () => {
          const r = (await routeBatch(model, [{ id: c.id, authorName: "Kemal Ediz", body: c.text }], {})).routes[0];
          return { route: r?.route ?? "nowhere", pastedList: r?.pastedList === true };
        })();
    if (["self_att", "other_att", "offer", "unsure"].includes(v.route)) {
      const ex = await extractForRoute(model, v.route as never, { id: c.id, body: c.text, authorName: "Kemal Ediz", tagged: true, history, lastBotPost: c.lastBotPost });
      if (ex.facts.kind === "attendance") v.teamsSide = ex.facts.sideRequests.includes("teams" as never);
    }
    if (v.route === "balancer") {
      const ex = await extractForRoute(model, "balancer", { id: c.id, body: c.text, authorName: "Kemal Ediz", tagged: true, history, lastBotPost: c.lastBotPost });
      if (ex.facts.kind === "teams") {
        v.action = ex.facts.action;
        v.shape = ex.facts.action === "swap" ? playersSwapShape(ex.facts).kind : undefined;
      }
      v.facts = JSON.stringify(ex.facts);
    }
    const ok = c.want(v);
    if (!ok) failed++;
    console.log(`${c.record ? "rec " : ok ? "ok  " : "FAIL"} ${c.id.padEnd(4)} routed ${v.route.padEnd(9)} ${v.action ?? ""} ${v.shape ?? ""}${v.pastedList ? " pasted_list" : ""}${v.teamsSide ? " +teams" : ""}   (${c.why})`);
    if (v.facts) console.log(`       facts ${v.facts}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed. ${calls} model call(s), $${usd.toFixed(4)}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
