/**
 * THE ADMIN GROUP THROUGH THE SHARED ROUTER: THE PAID CHECK (2026-10-16).
 *
 * Approved by Kemal on 2026-10-16 for this change: dev key only, run once.
 * The unit and e2e tests stub the model; they prove the wiring and the
 * safe-YES rule, not that the real router reads an organiser's own words.
 * This does, ONCE per case, through the exact prompts, models and context
 * lines production sends (`renderRouterTurn`, `organisersContext`,
 * `extractForRoute`):
 *
 *   - the organisers' group: posters and team sheets, swaps, moves and
 *     reshuffles in natural words, help, YES (quoted, next, after chat),
 *     squad changes, organiser chatter (must be none), EN and TR;
 *   - the rewritten teams extractor, on what the players' group already
 *     asks it (generate, show, rename, pairings, includes, Turkish) and
 *     the new moves.
 *
 * The players' group router regressions are the existing harnesses, run
 * once each beside this: `replay:router-regressions`,
 * `replay:router-attendance`, `replay:router-recall`.
 *
 *   ANTHROPIC_API_KEY_DEV=... npx tsx scripts/live-check-admin-group.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, pass or fail, the calls made and the
 * cost. Stops at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext, type PendingWithLabel } from "../src/lib/admin-group-context.ts";
import { teamCommandFromFacts } from "../src/lib/team-proposal-rules.ts";
import type { Route, TeamFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = 3;

spendDevApiKeyOrExit("the admin-group live check");

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

const ASKED = new Date("2026-10-16T09:00:00Z");
const TEAMS_TEXT = "📝 *Proposed teams*: 21:00 at Goals Sutton\n\n*Red*:\n1. Ali Khan\n2. Bilal Ahmed\n\n*Yellow*:\n1. Tom Third\n2. Sam Stone\n\nReply *YES* to make them final.";
const TEAMS_WAITING: PendingWithLabel[] = [{ ref: "teams:m1", kind: "teams", day: "Fri 16 Oct", askedAt: ASKED }];

interface Ctx {
  pending?: PendingWithLabel[];
  quoted?: { text: string; fromMatchTime: boolean };
  recent?: Array<{ fromMatchTime: boolean; text: string }>;
}
const waiting: Ctx = { pending: TEAMS_WAITING, recent: [{ fromMatchTime: true, text: TEAMS_TEXT }] };
const nothing: Ctx = { pending: [] };

interface HqCase {
  text: string;
  ctx: Ctx;
  /** Routes that pass. */
  want: Route[];
  /** For balancer: the team command the extractor must yield. */
  command?: ReturnType<typeof teamCommandFromFacts>;
  why: string;
}

const HQ: HqCase[] = [
  // Posters and team sheets, in natural words (the FNF failure, 2026-10-16).
  { text: "can you do the poster for this week", ctx: nothing, want: ["poster"], why: "poster, natural" },
  { text: "Can we get the list graphic please so I can post it", ctx: nothing, want: ["poster"], why: "poster, natural" },
  { text: "liste posterini hazırlar mısın", ctx: nothing, want: ["poster"], why: "poster, TR" },
  { text: "@Match Time poster", ctx: nothing, want: ["poster"], why: "old exact command" },
  { text: "send the team sheet so we can share it", ctx: waiting, want: ["team_sheet"], why: "team sheet, natural" },
  { text: "takımların görselini atar mısın", ctx: waiting, want: ["team_sheet"], why: "team sheet, TR" },
  { text: "team sheet", ctx: waiting, want: ["team_sheet"], why: "old exact command" },
  // Team changes in natural words.
  { text: "swap Ali and Bilal", ctx: waiting, want: ["balancer"], command: { kind: "swap", pairs: [["Ali", "Bilal"]] }, why: "swap" },
  { text: "can you put Tom on the other team", ctx: waiting, want: ["balancer"], command: { kind: "move", name: "Tom" }, why: "move, natural" },
  { text: "Sam ile Ali'yi değiştir", ctx: waiting, want: ["balancer"], command: { kind: "swap", pairs: [["Sam", "Ali"]] }, why: "swap, TR" },
  { text: "Tom'u diğer takıma al", ctx: waiting, want: ["balancer"], command: { kind: "move", name: "Tom" }, why: "move, TR" },
  { text: "put Sam in yellow", ctx: waiting, want: ["balancer"], command: { kind: "move", name: "Sam", to: "YELLOW" }, why: "move to a named side" },
  { text: "shuffle the teams again please, red looks too strong", ctx: waiting, want: ["balancer"], command: { kind: "reshuffle" }, why: "reshuffle, natural" },
  { text: "yeniden karıştır", ctx: waiting, want: ["balancer"], command: { kind: "reshuffle" }, why: "reshuffle, TR" },
  { text: "teams", ctx: nothing, want: ["balancer"], command: { kind: "show" }, why: "old exact command" },
  { text: "reshuffle", ctx: waiting, want: ["balancer"], command: { kind: "reshuffle" }, why: "old exact command" },
  // Help.
  { text: "what can you do?", ctx: nothing, want: ["help"], why: "help, natural" },
  { text: "how do I get you to make the teams?", ctx: nothing, want: ["help", "balancer"], why: "help-style question" },
  { text: "help", ctx: nothing, want: ["help"], why: "old exact command" },
  { text: "neler yapabiliyorsun?", ctx: nothing, want: ["help"], why: "help, TR" },
  { text: "yardım", ctx: nothing, want: ["help"], why: "old exact command, TR" },
  // YES.
  { text: "YES", ctx: { ...waiting, quoted: { text: TEAMS_TEXT, fromMatchTime: true } }, want: ["approve"], why: "YES as a quoted reply to the teams" },
  { text: "looks good, go ahead", ctx: waiting, want: ["approve"], why: "approval, natural" },
  { text: "evet", ctx: waiting, want: ["approve"], why: "approval, TR" },
  {
    text: "yes",
    ctx: { pending: TEAMS_WAITING, recent: [{ fromMatchTime: true, text: TEAMS_TEXT }, { fromMatchTime: false, text: "shall we book the pitch for next week too?" }] },
    want: ["approve"],
    why: "YES after unrelated chat: approve, so the safe-YES rule ASKS (none would be silent)",
  },
  {
    text: "yes",
    ctx: { ...waiting, quoted: { text: "shall we start at 8 instead?", fromMatchTime: false } },
    want: ["approve", "none"],
    why: "YES quoting another organiser: code stays silent on either route",
  },
  // Squad changes (existing behaviour).
  { text: "Tom out", ctx: nothing, want: ["other_att"], why: "squad change, old" },
  { text: "put Bilal in", ctx: nothing, want: ["other_att"], why: "squad change, old" },
  { text: "Bilal is not coming tonight, his knee is gone", ctx: waiting, want: ["other_att"], why: "squad change, natural (held out of the prompt)" },
  { text: "Ali gelemiyor", ctx: nothing, want: ["other_att"], why: "squad change, TR" },
  // Organiser chatter: must stay silent.
  { text: "who is bringing the bibs?", ctx: waiting, want: ["none"], why: "chatter" },
  { text: "I reckon red is stronger, no?", ctx: waiting, want: ["none"], why: "chatter about the teams" },
  { text: "yarın kim topları getiriyor?", ctx: nothing, want: ["none"], why: "chatter, TR" },
  { text: "nice one lads 👍", ctx: nothing, want: ["none"], why: "chatter" },
  { text: "I'll call the pitch tomorrow about the booking", ctx: nothing, want: ["none"], why: "chatter" },
  { text: "yes", ctx: { pending: [], recent: [{ fromMatchTime: false, text: "can you do Friday?" }] }, want: ["none", "approve"], why: "yes between organisers, nothing waiting: code silent on either" },
];

interface TeamsCase {
  text: string;
  check: (f: TeamFacts) => boolean;
  why: string;
}
const lc = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());
const TEAMS: TeamsCase[] = [
  { text: "@Match Time generate the teams", check: (f) => f.action === "generate", why: "generate" },
  { text: "@Match Time regenerate the teams once more with Erdal's rating updated", check: (f) => f.action === "generate", why: "generate, again" },
  { text: "@Match Time generate the teams now, come up with fun team names", check: (f) => f.action === "generate" && f.teamNames === null, why: "generate wins over rename" },
  { text: "@Match Time show me the teams", check: (f) => f.action === "show", why: "show" },
  { text: "@Match Time generate the teams, put me and David together", check: (f) => f.action === "generate" && JSON.stringify(f.pairings.map(lc)) === JSON.stringify([["me", "david"]]), why: "pairing" },
  { text: "@Match Time generate the teams, Ibrahim is playing", check: (f) => f.action === "generate" && lc(f.includeRefs).includes("ibrahim"), why: "include" },
  { text: "@Match Time make the teams and put David in Red", check: (f) => f.action === "generate" && f.swaps.some((s) => s.personRef === "David" && s.team === "RED"), why: "pin to a side" },
  { text: "@Match Time call the teams Lions and Tigers, same line-ups", check: (f) => f.action === "rename" && f.teamNames?.[0] === "Lions", why: "rename" },
  { text: "takımları kur", check: (f) => f.action === "generate", why: "generate, TR" },
  { text: "takımları göster", check: (f) => f.action === "show", why: "show, TR" },
  { text: "beni ve Ali'yi aynı takıma koy, takımları kur", check: (f) => f.action === "generate" && JSON.stringify(f.pairings.map(lc)) === JSON.stringify([["me", "ali"]]), why: "pairing, TR" },
  { text: "@Match Time do not regenerate the teams. Instead swap Elvin with Raihan", check: (f) => f.action === "swap" && lc(f.moves).join(",") === "elvin,raihan", why: "swap, no side (moves)" },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  let pass = 0;
  let fail = 0;
  console.log(`\n== Organisers' group: ${HQ.length} cases, each once ==\n`);
  for (const [i, c] of HQ.entries()) {
    const id = `hq${i}`;
    const context = organisersContext({
      pending: c.ctx.pending ?? [],
      quoted: c.ctx.quoted ?? null,
      quotedIsMatchTime: c.ctx.quoted?.fromMatchTime ?? false,
      recent: c.ctx.recent ?? [],
    });
    const r = await routeBatch(model, [{ id, authorName: "Raihan", body: c.text, organisers: { context } }], { floor: true });
    const route = r.routes[0]?.route;
    let ok = !!route && c.want.includes(route);
    let extra = "";
    if (ok && c.command && route === "balancer") {
      const ex = await extractForRoute(model, "balancer", { id, body: c.text, authorName: "Raihan", tagged: true, history: [], lastBotPost: null });
      const got = ex.facts.kind === "teams" ? teamCommandFromFacts(ex.facts) : null;
      ok = same(got, c.command);
      extra = ` -> ${JSON.stringify(got)}`;
    }
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  routed ${route}${extra}   (${c.why}; want ${c.want.join("|")}${c.command ? ` ${JSON.stringify(c.command)}` : ""})`);
  }

  console.log(`\n== Teams extractor (players' group behaviours and moves): ${TEAMS.length} cases, each once ==\n`);
  for (const [i, c] of TEAMS.entries()) {
    const ex = await extractForRoute(model, "balancer", { id: `t${i}`, body: c.text, authorName: "Kemal", tagged: true, history: [], lastBotPost: null });
    const f = ex.facts.kind === "teams" ? ex.facts : null;
    const ok = !!f && c.check(f);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)}  ${JSON.stringify(f && { action: f.action, includeRefs: f.includeRefs, teamNames: f.teamNames, swaps: f.swaps, moves: f.moves, pairings: f.pairings })}   (${c.why})`);
  }

  console.log(`\n${pass} passed, ${fail} failed. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
