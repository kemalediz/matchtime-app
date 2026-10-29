/**
 * TELLING MATCHTIME TO FIND PLAYERS IS admin_ops: THE PAID CHECK (2026-10-29).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * The incident: in the players' group the owner wrote "@Match Time invite
 * players from pool". On main the router split it 5 offer / 5 admin_ops in
 * 10 replays: `admin_ops` never named finding players and the pool was not
 * in the prompt, so half the time it reached the attendance extractor
 * instead of the admin extractor's recruit (pool, partners, both, or ask
 * which). The boundary: telling MATCHTIME to go and find players is
 * admin_ops; members asking the GROUP for a player stays offer/other_att.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-router-find-players.ts
 *
 *   REPEAT=10 (default) for the incidents; BOUNDARY_REPEAT=1 for the
 *   boundary set; OLD_PROMPT=<json> runs the same cases on a saved old
 *   prompt ({system, partnerLine}) for the before/after comparison;
 *   JSON=<path> writes every result; ONLY="a|b" runs just those texts.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { partnerClubsLine, routeBatch } from "../src/lib/pipeline/router.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 1);
const PARTNERS = ["Friday MT Community", "Sutton FC"];

spendDevApiKeyOrExit("the router find-players live check");

const old = process.env.OLD_PROMPT
  ? (JSON.parse(readFileSync(process.env.OLD_PROMPT, "utf8")) as { system: string; partnerLine: string })
  : null;

let calls = 0;
let usd = 0;
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const swapped = old
      ? { ...req, system: old.system, user: req.user.replace(partnerClubsLine(PARTNERS), old.partnerLine) }
      : req;
    const r = await inner.complete(swapped);
    calls++;
    usd += r.costUsd ?? 0;
    return r;
  },
};

interface Case {
  text: string;
  hq?: boolean;
  partners?: boolean;
  want: Route[];
  why: string;
}

const INCIDENTS: Case[] = [
  { text: "@Match Time invite players from pool", want: ["admin_ops"], why: "the incident, owner, no partner clubs" },
  { text: "@Match Time invite players from pool and partner clubs", partners: true, want: ["admin_ops"], why: "pool and partners, owner with partners" },
  { text: "@Match Time havuzdan oyuncu davet et", want: ["admin_ops"], why: "the incident, TR" },
  { text: "@Match Time find us a player", want: ["admin_ops"], why: "no place named" },
];

const BOUNDARY: Case[] = [
  // Telling MatchTime to find players: admin_ops.
  { text: "@Match Time ask the pool for a player", want: ["admin_ops"], why: "pool" },
  { text: "@Match Time get someone from the player pool for tonight", want: ["admin_ops"], why: "pool, held out" },
  { text: "@Match Time invite players from the pool", partners: true, want: ["admin_ops"], why: "pool, owner with partners" },
  { text: "@Match Time ask Friday MT Community if anyone can play", partners: true, want: ["admin_ops"], why: "a named partner club (slice S6)" },
  { text: "@Match Time ask the partner clubs for 2 players", partners: true, want: ["admin_ops"], why: "the partner clubs" },
  { text: "@Match Time partner kulüplere sor, oyuncu lazım", partners: true, want: ["admin_ops"], why: "partners, TR" },
  { text: "@Match Time we're short, find us a player", partners: true, want: ["admin_ops"], why: "no place named, owner with partners" },
  { text: "@Match Time bize bir oyuncu bul", want: ["admin_ops"], why: "no place named, TR" },
  { text: "@Match Time we need 2 more, can you round some up?", want: ["admin_ops"], why: "no place named, held out" },
  // Members asking the GROUP for a player: offer / other_att.
  { text: "@Match Time we need one more, anyone?", partners: true, want: ["offer"], why: "asks the group (S6 measured offer 10/10)" },
  { text: "We need one more player guys, anyone interested?", want: ["offer"], why: "asks the group" },
  { text: "anyone free tonight? we're one short", want: ["offer"], why: "asks the group, held out" },
  { text: "bir kişi eksiğiz, gelebilecek var mı?", want: ["offer"], why: "asks the group, TR" },
  { text: "Hi guys, does anyone wants to take my place for tonight?", want: ["other_att"], why: "the sender leaving" },
  { text: "@Match Time can someone take my spot tonight?", want: ["other_att"], why: "the sender leaving, tagged" },
  { text: "is anyone able to replace me and Habib tonight?", want: ["other_att"], why: "two leaving" },
  // Talk about the pool, not an instruction: none.
  { text: "the player pool thing is a good idea, we should use it more", want: ["none"], why: "talk about the bot" },
  { text: "I'll ask my brother if he can play", want: ["none", "offer"], why: "the sender's own plan" },
  // The organisers' group: ask_group stays the route there.
  { text: "we're one short, can you find us a player", hq: true, want: ["ask_group"], why: "HQ, the prompt's own example" },
  { text: "@Match Time ask the pool for a player", hq: true, want: ["ask_group", "admin_ops"], why: "HQ, pool (either owner reads recruit)" },
  { text: "one short this week, any ideas?", hq: true, want: ["none"], why: "HQ, organisers talking" },
  { text: "I'll ask the lads in the group later", hq: true, want: ["none"], why: "HQ, organiser's own plan" },
];

const results: Array<Record<string, unknown>> = [];

async function routeOnce(c: Case, i: number): Promise<Route | undefined> {
  const context = organisersContext({ pending: [], recent: [] });
  const r = await routeBatch(
    model,
    [{
      id: `c${i}`,
      authorName: c.hq ? "Hamzah" : "Kemal",
      body: c.text,
      ...(c.hq ? { organisers: { context, senderIsOrganiser: true } } : {}),
      ...(c.partners && !c.hq ? { partnerClubs: PARTNERS } : {}),
    }],
    { floor: false, awaiting: null },
  );
  return r.routes[0]?.route;
}

async function runSet(label: string, all: Case[], repeat: number) {
  const only = process.env.ONLY?.split("|");
  const cases = only ? all.filter((c) => only.includes(c.text)) : all;
  console.log(`\n== ${label}: ${cases.length} cases x ${repeat} ==\n`);
  let ok = 0;
  let n = 0;
  for (const [i, c] of cases.entries()) {
    const got: string[] = [];
    for (let k = 0; k < repeat; k++) {
      const route = await routeOnce(c, i).catch((e) => `error:${(e as Error).message}`);
      got.push(String(route));
      n++;
      if (c.want.includes(route as Route)) ok++;
    }
    const pass = got.filter((g) => c.want.includes(g as Route)).length;
    console.log(`${pass === repeat ? "PASS" : "FAIL"} ${pass}/${repeat}  ${c.hq ? "[HQ] " : ""}${c.partners ? "[partners] " : ""}"${c.text}" want ${c.want.join("|")} got ${got.join(",")}`);
    results.push({ set: label, text: c.text, hq: !!c.hq, partners: !!c.partners, want: c.want, got, pass, repeat });
  }
  console.log(`\n${label}: ${ok}/${n}`);
}

async function main() {
  console.log(old ? "PROMPT: OLD (saved)" : "PROMPT: NEW (this branch)");
  const repeat = Number(process.env.REPEAT ?? 10);
  const boundaryRepeat = Number(process.env.BOUNDARY_REPEAT ?? 1);
  if (repeat > 0) await runSet("incidents", INCIDENTS, repeat);
  if (boundaryRepeat > 0) await runSet("boundary", BOUNDARY, boundaryRepeat);
  console.log(`\ncalls ${calls}, cost $${usd.toFixed(4)}`);
  if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ old: !!old, calls, usd, results }, null, 1));
}

main().catch((e) => {
  console.error(e);
  console.log(`\ncalls ${calls}, cost $${usd.toFixed(4)}`);
  process.exit(1);
});
