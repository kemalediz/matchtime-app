/**
 * LIVE CHECK: FNF HQ's team commands of 2026-10-29, each ONCE.
 *
 * The real messages that failed that evening, through what production
 * runs for an HQ message about the teams: the shared router (with the
 * organisers' context, the proposed teams just posted) and then the teams
 * extractor (with the recent chat and MatchTime's last post), and the
 * facts turned into the command `team-proposal.ts` carries out
 * (`teamCommandFromFacts`). What the command then does to the teams is
 * pinned by the unit and e2e tests; this checks the model reads them.
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-hq-teams-2026-10-29.ts
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext, type PendingWithLabel } from "../src/lib/admin-group-context.ts";
import { teamCommandFromFacts, type TeamCommand } from "../src/lib/team-proposal-rules.ts";

spendDevApiKeyOrExit("scripts/live-check-hq-teams-2026-10-29.ts");

const MAX_USD = 0.5;
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

const NON_BIBS = ["Feroz", "Alamgir", "Rafi", "Hamza", "Mo", "Uncle Najib", "Abdul-Hafeez", "Mojib", "Yaseen"];
const BIBS = ["Yorel", "Maj", "Imz", "Hamzah", "Akram", "Mahir", "Shehryar", "Habib", "Ali"];
const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");
// MatchTime's proposal as posted in FNF HQ at 17:34 UTC.
const PROPOSAL =
  `📝 *Proposed teams*: 20:30 at Harris Merton\n\n*Non Bibs*:\n${list(NON_BIBS)}\n\n*Bibs*:\n${list(BIBS)}\n\n` +
  "To change them, just tell me in your own words (for example *swap Feroz and Yorel*, *move Feroz to the other team* or *shuffle them again*).\n" +
  "Reply *YES* when they are final. I won't post them in the players' group.";
const PENDING: PendingWithLabel[] = [{ ref: "teams:m1", kind: "teams", day: "Fri 30 Oct", askedAt: new Date("2026-10-29T17:34:12Z") }];

// Raihan's two lists, 18:37 and 18:38, before "Swap them over".
const RAIHAN_LISTS = [
  "Swap \nMo\nMojib\nAlamgir\nFeroz\nYaseen\nRafi\nAbdul-Hafeez\nHamza\nUncle\n\nWith \n\nHamzah\nYorel\nAkram\nShehryar\nImz\nMaj\nMahir\nHabib\nAli",
];

const EIGHT =
  "Swap Feroz and Yorel \nSwap uncle Najib and Akram\nSwap Alamgir and shehryar \nSwap Abdul-Hafeez and imz \nSwap Mojib and Maj\nSwap yaseen and Mahir \nSwap Rafi and hamzah\nSwap Mo and Habib";
const EIGHT_NAMES = ["Feroz", "Yorel", "uncle Najib", "Akram", "Alamgir", "shehryar", "Abdul-Hafeez", "imz", "Mojib", "Maj", "yaseen", "Mahir", "Rafi", "hamzah", "Mo", "Habib"];

interface Case {
  id: string;
  text: string;
  sender: string;
  organiser: boolean;
  /** Chat before it, oldest first (MatchTime's proposal is always last but these). */
  before?: Array<{ fromMatchTime: boolean; author: string | null; text: string }>;
  /** The command it must yield; a function for a set of acceptable ones. */
  want: (c: TeamCommand | { kind: "unclear" } | null) => boolean;
  /** Routes accepted. Default balancer. */
  routes?: string[];
  why: string;
}

const lc = (xs: string[]) => xs.map((x) => x.toLowerCase().trim()).sort();
const sameSet = (a: string[], b: string[]) => JSON.stringify(lc(a)) === JSON.stringify(lc(b));
const isChange = (c: unknown): c is Extract<TeamCommand, { kind: "change" }> => !!c && (c as { kind: string }).kind === "change";
// Nine names that are exactly one whole team: the code swaps the teams over for that too.
const swapsSides = (c: unknown) => isChange(c) && (c.swapSides || sameSet(c.moves, BIBS) || sameSet(c.moves, NON_BIBS));

const CASES: Case[] = [
  { id: "F1", text: "Swap everyone on bibs with non bibs", sender: "Raihan", organiser: true, want: swapsSides, why: "whole teams swap over (19:10)" },
  { id: "F2", text: "@Match Time swap everyone on bibs to non bibs. Switch all 9", sender: "Raihan", organiser: true, want: swapsSides, why: "whole teams, tagged, 'all 9' (18:35)" },
  { id: "F3", text: "@Match Time move team 1 over to team 2 side", sender: "Imz", organiser: true, want: swapsSides, why: "team 1 over to team 2 (18:37)" },
  {
    id: "F4",
    text: "Swap them over",
    sender: "Raihan",
    organiser: true,
    before: RAIHAN_LISTS.map((text) => ({ fromMatchTime: false, author: "Raihan", text })),
    want: swapsSides,
    routes: ["balancer"],
    why: "after both teams were listed (18:38)",
  },
  { id: "F5", text: EIGHT, sender: "Hamzah", organiser: true, want: (c) => isChange(c) && sameSet(c.moves, EIGHT_NAMES) && !c.swapSides, why: "eight swaps on eight lines (19:22)" },
  {
    id: "F6",
    text: "Stick keeper. Ali and Habib on one team",
    sender: "Raihan",
    organiser: true,
    want: (c) => isChange(c) && c.together.some((g) => sameSet(g, ["Ali", "Habib"])),
    why: "a pair on teams that exist: targeted, never a reshuffle (17:35)",
  },
  { id: "F7", text: "@Match Time recommend swaps", sender: "Raihan", organiser: true, want: (c) => c?.kind === "suggest", why: "asked of MatchTime: suggest" },
  { id: "F7u", text: "Recommend swaps", sender: "Raihan", organiser: true, want: (c) => c?.kind === "suggest", why: "untagged, as sent at 17:32 (the 17:32 one never reached the extractor in production)" },
  { id: "F8", text: "Teams", sender: "Hamzah", organiser: true, want: (c) => c?.kind === "show", why: "show (17:34)" },
  // A player's talk: the router may call it balancer; HQ then stays silent
  // for a non-organiser untagged (code, not the model). Graded on the reading only.
  { id: "F9", text: "Akram & maj in the same team", sender: "Abdul-Hafeez", organiser: false, want: (c) => c === null || isChange(c), routes: ["balancer", "none", "other_att", "unsure"], why: "a player's untagged talk (17:32)" },
];

async function main() {
  const only = process.env.ONLY?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  let failed = 0;
  for (const c of cases) {
    const recent = [{ fromMatchTime: true, author: "MatchTime", text: PROPOSAL }, ...(c.before ?? [])];
    const context = organisersContext({ pending: PENDING, recent: recent.map((r) => ({ fromMatchTime: r.fromMatchTime, text: r.text })) });
    const r = await routeBatch(
      model,
      [{ id: c.id, authorName: c.sender, body: c.text, organisers: { context, senderIsOrganiser: c.organiser } }],
      { floor: true },
    );
    const route = r.routes[0]?.route ?? "nowhere";
    const routes = c.routes ?? ["balancer"];
    let ok = routes.includes(route);
    let got: TeamCommand | { kind: "unclear" } | null = null;
    let facts = "";
    if (route === "balancer") {
      const ex = await extractForRoute(model, "balancer", {
        id: c.id,
        body: c.text,
        authorName: c.sender,
        tagged: true,
        history: recent.map((h) => ({ author: h.author, body: h.text })),
        lastBotPost: PROPOSAL,
      });
      got = ex.facts.kind === "teams" ? teamCommandFromFacts(ex.facts) : null;
      facts = JSON.stringify(ex.facts);
    }
    if (route === "balancer" || !c.routes) ok = ok && c.want(got);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.id.padEnd(4)} routed ${route.padEnd(9)} ${JSON.stringify(got)}   (${c.why})`);
    if (facts) console.log(`       facts ${facts}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed. ${calls} model call(s), $${usd.toFixed(4)}.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
