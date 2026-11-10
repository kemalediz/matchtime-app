/**
 * A FORM NOTE IS FOR THE BALANCER, NOT A SETTING: THE PAID CHECK (2026-11-10).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * Sutton FC, Tue 10 Nov 2026 12:14: "@Match Time reduce my strength for this
 * match as I am quite tired." routed admin_ops (router, Haiku 5.5), the admin
 * extractor read it as "other", and the admin fallback sent the club's
 * settings page. The rating adjuster already reads the week's chat when the
 * teams are made, so the message does what was asked; it belongs to the
 * balancer route, whose teams extractor now has a "form" action answered
 * with one honest line.
 *
 * Three parts, each case ONCE:
 *   1. the router on the incident, form notes EN and TR, and the boundaries
 *      that must not move (a real setting, a stats question, attendance,
 *      untagged chat);
 *   2. the teams extractor on every case the router should send to balancer;
 *   3. the incident end to end: the live router, then the live teams
 *      extractor inside `runTeamOpsBatch` (club state stubbed, no database),
 *      printing the reply the group would get.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-form-note.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database, sends
 * nothing. Stops at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { runTeamOpsBatch } from "../src/lib/team-ops-engine-batch.ts";
import { world } from "../src/lib/pipeline/__tests__/helpers.ts";
import type { Route } from "../src/lib/pipeline/types.ts";

const MAX_USD = 0.3;

spendDevApiKeyOrExit("the form note live check");

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

const INCIDENT = "@Match Time reduce my strength for this match as I am quite tired.";

interface Case {
  text: string;
  want: Route[];
  hq?: boolean;
  why: string;
}

const CASES: Case[] = [
  { text: INCIDENT, want: ["balancer"], why: "the incident" },
  { text: "@Match Time bit hungover today, go easy on my rating tonight", want: ["balancer"], why: "hungover" },
  { text: "@Match Time bugün çok yorgunum, bu maç için puanımı düşür", want: ["balancer"], why: "tired, TR" },
  { text: "@Match Time I've hurt my knee, take it into account when you make the teams", want: ["balancer"], why: "injured knee" },
  { text: "@Match Time dizimden sakatlandım, takımlarda göz önünde bulundur", want: ["balancer"], why: "injured knee, TR" },
  { text: "@Match Time I'm feeling great today, rate me up", want: ["balancer"], why: "in form" },
  { text: "@Match Time Tom pulled his hamstring on Sunday, keep it in mind for the teams", want: ["balancer"], why: "another player injured" },
  { text: "@Match Time lower my strength for this match, I'm shattered", hq: true, want: ["balancer"], why: "HQ, tired" },
  // Boundaries that must not move.
  { text: "@Match Time change the kickoff to 8", want: ["admin_ops"], why: "a real setting" },
  { text: "@Match Time set the fee to 10", want: ["admin_ops"], why: "a real setting" },
  { text: "@Match Time what is Kemal's strength?", want: ["question"], why: "a stats question" },
  { text: "@Match Time Kemal'in gücü ne?", want: ["question"], why: "a stats question, TR" },
  { text: "Knackered after work but I'm in", want: ["self_att"], why: "tired AND a place: the place wins" },
  { text: "so tired today lads", want: ["none"], why: "untagged chat" },
];

async function routeOnce(c: Case, i: number): Promise<Route | undefined> {
  const context = organisersContext({ pending: [], recent: [] });
  const r = await routeBatch(
    model,
    [{ id: `c${i}`, authorName: c.hq ? "Hamzah" : "Kemal Ediz", body: c.text, ...(c.hq ? { organisers: { context } } : {}) }],
    { floor: false, awaiting: null },
  );
  return r.routes[0]?.route;
}

async function main() {
  console.log(`\n== 1. Router: ${CASES.length} cases x 1 ==\n`);
  let ok = 0;
  for (const [i, c] of CASES.entries()) {
    const got = (await routeOnce(c, i)) ?? "missing";
    const pass = c.want.includes(got as Route);
    if (pass) ok++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)} -> ${got}   (${c.why}; want ${c.want.join("|")})`);
  }
  console.log(`-- router: ${ok}/${CASES.length}`);

  const toBalancer = CASES.filter((c) => c.want.includes("balancer"));
  const extra = ["@Match Time generate the teams, Tom's knee is bad so go easy on him"];
  console.log(`\n== 2. Teams extractor: ${toBalancer.length + extra.length} cases x 1 ==\n`);
  let eok = 0;
  for (const [i, text] of [...toBalancer.map((c) => c.text), ...extra].entries()) {
    const want = extra.includes(text) ? "generate" : "form";
    const ex = await extractForRoute(model, "balancer", { id: `t${i}`, body: text, authorName: "Kemal Ediz", tagged: true, history: [], lastBotPost: null });
    const a = ex.facts.kind === "teams" ? ex.facts.action : `(${ex.facts.kind})`;
    if (a === want) eok++;
    console.log(`${a === want ? "PASS" : "FAIL"}  ${JSON.stringify(text)} -> ${a}   (want ${want})`);
  }
  console.log(`-- teams extractor: ${eok}/${toBalancer.length + extra.length}`);

  console.log(`\n== 3. The incident end to end (live router, live extractor, club state stubbed) ==\n`);
  const route = await routeOnce(CASES[0]!, 99);
  console.log(`router: ${route}`);
  if (route === "balancer") {
    const res = await runTeamOpsBatch({
      orgId: "org-sutton",
      now: new Date("2026-11-10T12:14:31Z"),
      messages: [
        {
          waMessageId: "wa-incident",
          body: INCIDENT,
          authorName: "Kemal Ediz",
          senderUserId: "u-kemal",
          senderName: "Kemal Ediz",
          tagged: true,
          taggedExplicitly: true,
          route: "balancer",
          gated: false,
        },
      ],
      history: [],
      enabled: new Set<Route>(["balancer"]),
      deps: {
        model,
        loadState: async () => world({ confirmed: ["kemal", "elvin"] }),
        loadFeatures: async () =>
          ({ botEnabled: true, attendance: true, bench: true, teamBalancing: true, momVoting: true, playerRating: true, reminders: true, statsQa: true, paymentTracking: false, paymentCollection: false, squadFromList: false, language: "en", rollingSquad: false, benchPickMode: "first-come", badgeAnnouncements: true, squadMode: "weekly" }) as never,
        selectTeamsMatch: async () => ({ id: "match-1", date: new Date("2026-11-10T20:30:00Z") }),
        forceConfirm: async () => {
          throw new Error("must not confirm anyone");
        },
        generateTeams: async () => {
          throw new Error("must not build teams");
        },
      },
    });
    const o = res.outcomes.get("wa-incident");
    console.log(`intent: ${o?.intent}\nreply: ${JSON.stringify(o?.reply)}`);
  }

  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
