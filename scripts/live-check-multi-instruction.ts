/**
 * LIVE CHECK: several instructions in one message (2026-11-16, Vets), and
 * the router's existing behaviours on the rewritten prompt, each ONCE.
 *
 * The incident: "@Match Time switch to 7aside, take Luca to bench,
 * @<mention> is IN and then make the teams" got one route (other_att) and
 * two of its four parts were dropped. The router now lists a message's
 * other instructions in `also` (`router.ts`, `multi-route.ts`).
 *
 * THREE GROUPS, every name made up:
 *   incident  the incident's shape, through the router AND the three
 *             extractors that then read the whole message (admin: the
 *             switch to 7; attendance: Luca to the bench, Zak in; teams:
 *             generate), so each owner is shown to read only its own part;
 *   multi     other messages with two or three instructions, EN and TR,
 *             in both groups;
 *   existing  single-instruction messages the router already handled,
 *             which must keep their route and have an EMPTY also (none of
 *             these sentences is in the prompt's examples).
 *
 *   node --env-file=<repo>/.env ./node_modules/.bin/tsx scripts/live-check-multi-instruction.ts
 *
 * Estimated: 22 router calls + 3 extractor calls = 25 calls, about $0.05
 * (Haiku 5.5 at $0.10 and $0.50 per million tokens: a router call is about
 * 9,500 tokens in, mostly cached after the first, and 300 to 600 out).
 * Stops at MAX_USD (default $1). JSON=<path> writes every result.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing.
 */
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch, type RouterMessage } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { isAttendanceRoute } from "../src/lib/pipeline/multi-route.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("the several-instructions live check");

const MAX_USD = Number(process.env.MAX_USD ?? 1);
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

type Where = "players" | "hq";
/** "att" means any attendance route. */
type Want = Route | "att";
interface Case {
  set: "incident" | "multi" | "existing";
  where: Where;
  text: string;
  /** Routes the owner may be. */
  route: Want[];
  /** The other parts that must be listed, exactly (order free). */
  also: Route[];
}

const CASES: Case[] = [
  // ── the incident ───────────────────────────────────────────────────
  { set: "incident", where: "players", text: "@Match Time switch to 7aside, take Luca to bench, @Zak is IN and then make the teams", route: ["att"], also: ["admin_ops", "balancer"] },

  // ── several instructions ───────────────────────────────────────────
  { set: "multi", where: "players", text: "@Match Time 7 kişilik yap, Luca yedeğe geçsin, Zak var, sonra takımları kur", route: ["att"], also: ["admin_ops", "balancer"] },
  { set: "multi", where: "players", text: "@Match Time let's go 8 a side tonight and sort the teams out", route: ["admin_ops"], also: ["balancer"] },
  { set: "multi", where: "players", text: "@Match Time I can't make it tonight, who's playing now?", route: ["att"], also: ["question"] },
  { set: "multi", where: "players", text: "@Match Time Theo is out, Remy is in, and swap Omar with Felix", route: ["att"], also: ["balancer"] },
  { set: "multi", where: "players", text: "@Match Time remind me on Thursday at 9am, and put me down as IN", route: ["att"], also: ["admin_ops"] },
  { set: "multi", where: "players", text: "@Match Time bu akşam 6 kişilik oynayalım ve takımları yap", route: ["admin_ops"], also: ["balancer"] },
  { set: "multi", where: "hq", text: "@Match Time switch Monday to 6 aside and put Sami on the bench", route: ["att"], also: ["admin_ops"] },
  { set: "multi", where: "hq", text: "@Match Time Nico is out, Remy is in, then make the teams", route: ["att"], also: ["balancer"] },

  // ── existing behaviour: one instruction, also empty ───────────────
  { set: "existing", where: "players", text: "In", route: ["self_att"], also: [] },
  { set: "existing", where: "players", text: "Rory OUT", route: ["other_att"], also: [] },
  { set: "existing", where: "players", text: "@Match Time Rory IN, Dev IN, Pax out", route: ["other_att"], also: [] },
  { set: "existing", where: "players", text: "Hi lads, Ezra is replacing Milo on the list tonight", route: ["other_att"], also: [] },
  { set: "existing", where: "players", text: "@Sam could you change it to 6 a side and add Noel as the 12th", route: ["att"], also: [] },
  { set: "existing", where: "players", text: "@Match Time make the teams please", route: ["balancer"], also: [] },
  { set: "existing", where: "players", text: "@Match Time swap Omar with Felix", route: ["balancer"], also: [] },
  { set: "existing", where: "players", text: "@Match Time how many are in so far?", route: ["question"], also: [] },
  { set: "existing", where: "players", text: "@Match Time switch tonight's game to 7 aside", route: ["admin_ops"], also: [] },
  { set: "existing", where: "players", text: "6-4 to the Yellows tonight", route: ["score"], also: [] },
  { set: "existing", where: "players", text: "haha what a finish last night 😂", route: ["none"], also: [] },
  { set: "existing", where: "players", text: "@Match Time cheers mate 👍", route: ["none"], also: [] },
  { set: "existing", where: "hq", text: "@Match Time we're two short, can you find us a couple of players", route: ["ask_group"], also: [] },
];

function routeOk(got: Route | undefined, want: Want[]): boolean {
  if (!got) return false;
  return want.some((w) => (w === "att" ? isAttendanceRoute(got) : w === got));
}

async function route(c: Case, i: number) {
  const hq = c.where === "hq";
  const msg: RouterMessage = {
    id: `c${i}`,
    authorName: hq ? "Ava" : "Ava",
    body: c.text,
    ...(hq ? { organisers: { context: organisersContext({ pending: [], recent: [] }), senderIsOrganiser: true } } : {}),
  };
  const r = await routeBatch(model, [msg], { awaiting: null });
  return { routed: r.routes[0], degradations: r.degradations.map((d) => d.detail) };
}

async function incidentReads(text: string) {
  const input = { id: "x1", body: text, authorName: "Ava", tagged: true, history: [], lastBotPost: null, now: new Date() };
  const admin = await extractForRoute(model, "admin_ops", input);
  const att = await extractForRoute(model, "other_att", input);
  const teams = await extractForRoute(model, "balancer", input);
  const a = admin.facts as unknown as Record<string, unknown>;
  const claims = att.facts.kind === "attendance" ? att.facts.claims.map((c) => `${c.personRef || c.subject}:${c.polarity}`) : [];
  const teamAction = teams.facts.kind === "teams" ? teams.facts.action : `(${teams.facts.kind})`;
  const adminOk = a.action === "switch_format" && Number(a.size) === 7;
  const lower = claims.map((c) => c.toLowerCase());
  const attOk = lower.some((c) => c.includes("luca") && c.endsWith(":bench")) && lower.some((c) => c.includes("zak") && c.endsWith(":in")) && claims.length === 2;
  const teamsOk = teamAction === "generate";
  return { admin: `${a.action} size ${a.size}`, claims, teamAction, ok: adminOk && attOk && teamsOk, adminOk, attOk, teamsOk };
}

async function main() {
  const results: Array<Record<string, unknown>> = [];
  const tally: Record<string, [number, number]> = {};
  for (const [i, c] of CASES.entries()) {
    const { routed, degradations } = await route(c, i);
    const also = [...(routed?.alsoRoutes ?? [])].sort();
    const want = [...c.also].sort();
    let pass = routeOk(routed?.route, c.route) && JSON.stringify(also) === JSON.stringify(want);
    let reads: Awaited<ReturnType<typeof incidentReads>> | null = null;
    if (c.set === "incident") {
      reads = await incidentReads(c.text);
      pass = pass && reads.ok;
    }
    const t = (tally[c.set] ??= [0, 0]);
    t[1]++;
    if (pass) t[0]++;
    results.push({ ...c, got: routed?.route, gotAlso: routed?.alsoRoutes ?? [], source: routed?.source, degradations, reads, pass });
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${c.set.padEnd(8)} ${c.where.padEnd(7)} ${JSON.stringify(c.text).padEnd(96)} ` +
        `route ${String(routed?.route).padEnd(9)} also [${(routed?.alsoRoutes ?? []).join(",")}]` +
        `  (want ${c.route.join("|")}, also [${c.also.join(",")}])` +
        (reads ? `\n        extractors: admin ${reads.admin}; attendance ${reads.claims.join(", ")}; teams ${reads.teamAction}` : "") +
        (degradations.length ? `\n        degraded: ${degradations.join(" | ")}` : ""),
    );
  }
  console.log("");
  for (const [set, [ok, n]] of Object.entries(tally)) console.log(`-- ${set}: ${ok}/${n}`);
  console.log(`\n${calls} model calls, $${usd.toFixed(4)}`);
  if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ calls, usd, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${calls} model calls, $${usd.toFixed(4)} before the error`);
  process.exit(1);
});
