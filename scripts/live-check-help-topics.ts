/**
 * LIVE CHECK: "help <topic>" for EVERY word the help menus advertise, in the
 * players' group, the organisers' group (HQ) and by DM, English and Turkish,
 * each ONCE (2026-11-10).
 *
 * The short menus (#591) end "tag me with *help* and the topic", listing
 * the topic words. #591's paid checks found the ROUTER sending
 * "@Match Time help teams" in the players' group to `balancer` 2 of 2, and
 * "@Match Time yardım takımlar" in HQ once. Every listed word must reach the
 * help: the router routes it `question` (the players' group; its `help` is
 * read as `question` by `parseRouterResponse`) or `help`/`question` (HQ),
 * then the question extractor reads `how_it_works` with that topic's
 * feature. A DM has no router: the question extractor alone (`readDmHelp`).
 *
 * Also: the real requests that must keep their action ("make the teams",
 * "show the teams", "ask the group if anyone can play"), with the teams
 * extractor's action on every message the router sends to `balancer`, so a
 * help message that goes there is traced to what it would then do.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-help-topics.ts
 *
 *   OLD_PROMPT=<json with {system}> runs the router on a saved prompt (the
 *   before half of a before/after). JSON=<path> writes every result.
 *   SKIP_DM=1 leaves the DM half out (it does not touch the router).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD (default $1).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { ROUTER_SYSTEM_PROMPT, routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { HelpFeature, Route } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("the help topics live check");

const MAX_USD = Number(process.env.MAX_USD ?? 1);
const old = process.env.OLD_PROMPT ? (JSON.parse(readFileSync(process.env.OLD_PROMPT, "utf8")) as { system: string }) : null;

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    // Only the router's system prompt is swapped; every extractor runs as shipped.
    const swapped = old && req.system === ROUTER_SYSTEM_PROMPT ? { ...req, system: old.system } : req;
    const r = await inner.complete(swapped);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

type Where = "players" | "hq" | "dm";

/** The players' group menu's words (`onbHelpTopicWord`), EN and TR. */
const PLAYERS_WORDS: Array<[string, string, HelpFeature]> = [
  ["availability", "kadro", "availability"],
  ["friend", "arkadaş", "friend"],
  ["teams", "takımlar", "teams"],
  ["mom", "maçın adamı", "mom"],
  ["ratings", "puanlama", "ratings"],
  ["badges", "rozetler", "badges"],
  ["reminders", "hatırlatma", "reminders"],
  ["payments", "ödeme", "payments"],
  ["partners", "partner", "partners"],
  ["pool", "havuz", "pool"],
  ["schedule", "program", "schedule"],
  ["settings", "ayarlar", "settings"],
];

/** The HQ menu's words (`hq_help_menu`). */
const HQ_WORDS: Array<[string, string, HelpFeature]> = [
  ["squad", "kadro", "availability"],
  ["teams", "takımlar", "teams"],
  ["players", "oyuncu bulma", "find_players"],
  ["game", "maç", "schedule"],
  ["settings", "ayarlar", "settings"],
  ["graphics", "görseller", "graphics"],
  ["payments", "ödeme", "payments"],
  ["partners", "partner", "partners"],
  ["pool", "havuz", "pool"],
  ["mom", "maçın adamı", "mom"],
  ["ratings", "puanlama", "ratings"],
  ["reminders", "hatırlatma", "reminders"],
];

interface HelpCase {
  where: Where;
  text: string;
  /** null: the menu. */
  feature: HelpFeature | null;
}

function helpCases(): HelpCase[] {
  const out: HelpCase[] = [];
  const tag = (w: Where) => (w === "dm" ? "" : "@Match Time ");
  for (const w of ["players", "hq", "dm"] as Where[]) {
    if (w === "dm" && process.env.SKIP_DM) continue;
    out.push({ where: w, text: `${tag(w)}help`, feature: null });
    out.push({ where: w, text: `${tag(w)}yardım`, feature: null });
    // A DM is sent the players' menu (`onboarding-conversation.ts`, dm: true).
    for (const [en, tr, feature] of w === "hq" ? HQ_WORDS : PLAYERS_WORDS) {
      out.push({ where: w, text: `${tag(w)}help ${en}`, feature });
      out.push({ where: w, text: `${tag(w)}yardım ${tr}`, feature });
    }
  }
  return out;
}

interface ActionCase {
  where: Exclude<Where, "dm">;
  text: string;
  want: Route[];
  /** For balancer: the teams extractor's action that must follow. */
  teamAction?: string[];
}

const ACTIONS: ActionCase[] = [
  { where: "players", text: "@Match Time make the teams", want: ["balancer"], teamAction: ["generate"] },
  { where: "players", text: "@Match Time takımları kur", want: ["balancer"], teamAction: ["generate"] },
  { where: "players", text: "@Match Time show the teams", want: ["balancer"], teamAction: ["show"] },
  { where: "players", text: "@Match Time ask the group if anyone can play", want: ["admin_ops", "offer"] },
  { where: "hq", text: "@Match Time make the teams", want: ["balancer"], teamAction: ["generate"] },
  { where: "hq", text: "@Match Time takımları kur", want: ["balancer"], teamAction: ["generate"] },
  { where: "hq", text: "@Match Time show the teams", want: ["balancer"], teamAction: ["show"] },
  { where: "hq", text: "@Match Time ask the group if anyone can play", want: ["ask_group"] },
];

async function route(where: Exclude<Where, "dm">, text: string, i: number): Promise<Route | undefined> {
  const hq = where === "hq";
  const context = organisersContext({ pending: [], recent: [] });
  const r = await routeBatch(
    model,
    [{ id: `c${i}`, authorName: hq ? "Hamzah" : "Can", body: text, ...(hq ? { organisers: { context, senderIsOrganiser: true } } : {}) }],
    { floor: false, awaiting: null },
  );
  return r.routes[0]?.route;
}

/** What the extractor of a wrong route reads a help message as: the trace of what it would then do. */
async function readAs(r: Route, text: string, i: number): Promise<string> {
  if (r === "balancer") return `teams extractor: ${await teamsAction(text, i)}`;
  const ex = await extractForRoute(model, r, { id: `x${i}`, body: text, authorName: "Can", tagged: true, history: [], lastBotPost: null, now: new Date() });
  const f = ex.facts as unknown as Record<string, unknown>;
  const detail = ["action", "source", "sources", "topic"].filter((k) => f[k] !== undefined).map((k) => `${k} ${JSON.stringify(f[k])}`);
  return `${r} extractor: ${f.kind}${detail.length ? `, ${detail.join(", ")}` : ""}`;
}

async function teamsAction(text: string, i: number): Promise<string> {
  const ex = await extractForRoute(model, "balancer", { id: `t${i}`, body: text, authorName: "Can", tagged: true, history: [], lastBotPost: null });
  return ex.facts.kind === "teams" ? ex.facts.action : `(${ex.facts.kind})`;
}

async function helpRead(text: string, i: number): Promise<{ topic: string; feature: string | null } | null> {
  const ex = await extractForRoute(model, "question", { id: `q${i}`, body: text, authorName: "Can", tagged: true, history: [], lastBotPost: null, now: new Date() });
  const f = ex.facts.kind === "question" ? ex.facts : null;
  return f && { topic: f.topic, feature: f.feature ?? null };
}

async function main() {
  console.log(old ? "ROUTER PROMPT: OLD (saved)" : "ROUTER PROMPT: NEW (this branch)");
  const results: Array<Record<string, unknown>> = [];

  console.log("\n== help <topic> ==\n");
  let ok = 0;
  // ONLY="where:text|where:text": just those help cases, and no action cases.
  const only = process.env.ONLY?.split("|");
  const cases = helpCases().filter((c) => !only || only.includes(`${c.where}:${c.text}`));
  for (const [i, c] of cases.entries()) {
    const r = c.where === "dm" ? ("question" as Route) : await route(c.where, c.text, i);
    const routeOk = r === "question" || (c.where === "hq" && r === "help");
    let read: Awaited<ReturnType<typeof helpRead>> = null;
    let teamAct: string | null = null;
    if (routeOk) read = await helpRead(c.text, i);
    else if (r && r !== "none") teamAct = await readAs(r, c.text, i);
    const pass = routeOk && !!read && read.topic === "how_it_works" && (read.feature ?? null) === c.feature;
    if (pass) ok++;
    results.push({ set: "help", where: c.where, text: c.text, route: c.where === "dm" ? "(no router)" : r, read, wrongRouteRead: teamAct, want: c.feature, pass });
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${c.where.padEnd(7)} ${JSON.stringify(c.text).padEnd(36)} route ${String(c.where === "dm" ? "-" : r).padEnd(9)} ` +
        `${read ? `${read.topic}/${read.feature ?? "menu"}` : (teamAct ?? "")}  (want ${c.feature ?? "menu"})`,
    );
  }
  console.log(`-- help: ${ok}/${cases.length}`);

  console.log("\n== real requests keep their action ==\n");
  let aok = 0;
  for (const [i, c] of (only ? [] : ACTIONS).entries()) {
    const r = await route(c.where, c.text, 100 + i);
    const act = r === "balancer" ? await teamsAction(c.text, 100 + i) : null;
    const pass = !!r && c.want.includes(r) && (!c.teamAction || (act !== null && c.teamAction.includes(act)));
    if (pass) aok++;
    results.push({ set: "actions", where: c.where, text: c.text, route: r, teamAction: act, want: c.want, pass });
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.where.padEnd(7)} ${JSON.stringify(c.text).padEnd(48)} route ${r}${act ? `, ${act}` : ""}  (want ${c.want.join("|")}${c.teamAction ? `, ${c.teamAction.join("|")}` : ""})`);
  }
  console.log(`-- actions: ${aok}/${ACTIONS.length}`);

  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ old: !!old, calls, usd, results }, null, 2));
  process.exit(ok === cases.length && (only || aok === ACTIONS.length) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
