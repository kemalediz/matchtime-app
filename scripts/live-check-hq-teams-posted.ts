/**
 * THE ORGANISERS' OWN TEAMS, POSTED UNTAGGED IN HQ: THE PAID CHECK
 * (2026-11-27).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only.
 *
 * FNF HQ, Fri 27 Nov 2026: an admin posted the night's two teams, untagged
 * ("Captains:\n\nAlamgir, Yorel, ...\n\nImti, Mo, ..."), then asked a human
 * for the graphic. MatchTime kept its own earlier split. Since this change
 * an organiser's untagged HQ message is read by the shared teams extractor
 * (`hq-teams-posted.ts`), and only its "set" reading (both teams written
 * out) may become the teams, silently, after code checks every name.
 *
 * Each case ONCE: the teams extractor (Haiku) on the shapes organisers
 * write teams in, and on ordinary HQ chat that must NOT read as "set".
 * Who-is-who on the incident's names (FNF's "Hamza" and "Hamzah", "Umar"
 * and "Umar Noor") is the LIVE block of e2e/sim/hq-teams-posted.spec.ts.
 * 2026-11-27: 8/8, 8 calls, $0.0027.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-hq-teams-posted.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Stops at MAX_USD.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";

const MAX_USD = 0.5;

spendDevApiKeyOrExit("the HQ posted-teams live check");

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

const NOW = new Date("2026-11-27T19:30:00Z");

const INCIDENT =
  "Captains:\n\nAlamgir, Yorel, Wasim, Shehryar, Rafi, Feroz, Hamza, Mojib, Yaseen\n\nImti, Mo, Akram, Niro, Clarence, Imz, AH, Seb, Umar";
const RED = ["Alamgir", "Yorel", "Wasim", "Shehryar", "Rafi", "Feroz", "Hamza", "Mojib", "Yaseen"];
const YELLOW = ["Imti", "Mo", "Akram", "Niro", "Clarence", "Imz", "AH", "Seb", "Umar"];

interface Case {
  id: string;
  text: string;
  /** "set" with these sides, or anything but "set". */
  want: { set: { red: string[]; yellow: string[] } } | "not-set";
}

const CASES: Case[] = [
  { id: "incident", text: INCIDENT, want: { set: { red: RED, yellow: YELLOW } } },
  {
    id: "team-a-b",
    text: "Team A\nAlamgir\nYorel\nWasim\n\nTeam B\nImti\nMo\nAkram",
    want: { set: { red: ["Alamgir", "Yorel", "Wasim"], yellow: ["Imti", "Mo", "Akram"] } },
  },
  {
    id: "bibs",
    text: "Bibs: Alamgir, Yorel, Wasim\nNon bibs: Imti, Mo, Akram",
    want: { set: { red: ["Alamgir", "Yorel", "Wasim"], yellow: ["Imti", "Mo", "Akram"] } },
  },
  {
    id: "turkish",
    text: "Takımlar:\nKırmızı: Ali, Can, Tom\nSarı: Elvin, Mehmet, Kemal",
    want: { set: { red: ["Ali", "Can", "Tom"], yellow: ["Elvin", "Mehmet", "Kemal"] } },
  },
  { id: "graphic-ask", text: "@Raihan please do graphic for the teams", want: "not-set" },
  { id: "chat-bibs", text: "who's bringing the bibs tonight?", want: "not-set" },
  { id: "chat-opinion", text: "Ali and Habib are always on the same team lol", want: "not-set" },
  { id: "squad-list", text: "Tonight's list:\n1. Alamgir\n2. Yorel\n3. Wasim\n4. Imti\n5. Mo\n6. Akram", want: "not-set" },
];

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());

async function main() {
  let fails = 0;
  for (const c of CASES) {
    const r = await extractForRoute(model, "balancer", {
      id: `live-${c.id}`,
      body: c.text,
      authorName: "Raihan",
      tagged: false,
      history: [],
      lastBotPost: null,
      now: NOW,
    });
    const f = r.facts;
    const action = f.kind === "teams" ? f.action : f.kind;
    const sides = f.kind === "teams" ? (f.sides ?? { red: [], yellow: [] }) : { red: [], yellow: [] };
    let ok: boolean;
    if (c.want === "not-set") ok = action !== "set";
    else ok = action === "set" && same(sides.red, c.want.set.red) && same(sides.yellow, c.want.set.yellow);
    if (!ok) fails++;
    console.log(`${ok ? "PASS" : "FAIL"} ${c.id}: ${action}${action === "set" ? ` red=${JSON.stringify(sides.red)} yellow=${JSON.stringify(sides.yellow)}` : ""}`);
  }
  console.log(`\n${CASES.length - fails}/${CASES.length} passed. ${calls} model call(s), $${usd.toFixed(4)}`);
  if (fails) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  console.log(`${calls} model call(s), $${usd.toFixed(4)}`);
  process.exit(1);
});
