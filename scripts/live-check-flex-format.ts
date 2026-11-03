/**
 * A GAME'S SIZES BY WHATSAPP: THE PAID CHECK (2026-11-03, the Vets play 6, 7
 * or 8 a side; Kemal: every admin feature also works by tagging MatchTime).
 * It replaces the minimum players check of #515 and keeps every one of its
 * cases, now read as `player_numbers`.
 *
 * Each case ONCE through the real router and the real admin extractor, the
 * way production reads it, in the players' group (PG) and the organisers'
 * group (HQ), a yes quoting MatchTime's suggestion included. The extractor
 * is read whatever the route, so a router miss and an extractor miss are
 * told apart. The numbers are turned into totals by the same code
 * production uses (`playerRangeWordsOf`, `perSideOf`).
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-flex-format.ts
 *   ONLY=<text> ...   the cases whose text contains it
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). No database,
 * sends nothing. Prints each case, the calls made and the cost.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { quoteFromPi } from "../src/lib/reply-context.ts";
import { perSideOf, playerRangeWordsOf } from "../src/lib/flex-format-rules.ts";
import type { AdminFacts } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.6);
spendDevApiKeyOrExit("the game sizes live check");

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

const NOW = new Date("2026-11-03T11:31:00Z");
const SUGGESTION = "We've got 16 for Monday, 2 on the bench. Shall we go 8-a-side? Davide, reply *yes* to this message and I'll switch it.";

/**
 * What the facts come to, after code:
 *   "min12", "max16", "min12-max16", "full", "min12@thursday" for player_numbers;
 *   "side8", "side8@monday" for switch_format; "none" with no usable number;
 *   "not(<action>)" for anything else.
 */
function got(f: AdminFacts | null): string {
  if (f?.action === "player_numbers") {
    const w = playerRangeWordsOf(f);
    if (w.fullTeams) return "full";
    const parts = [w.minPlayers ? `min${w.minPlayers}` : "", w.maxPlayers ? `max${w.maxPlayers}` : ""].filter(Boolean).join("-");
    return (parts || "none") + (w.matchDay ? `@${w.matchDay.toLowerCase()}` : "");
  }
  if (f?.action === "switch_format") {
    const s = perSideOf(f);
    return (s ? `side${s}` : "none") + (f.matchDay ? `@${f.matchDay.toLowerCase()}` : "");
  }
  return `not(${f?.action ?? "none"})`;
}
/** A day is matched loosely: "min8@thursday" is met by "min8@on thursday". */
const matches = (want: string, g: string) =>
  want === "not" ? g.startsWith("not") : want.includes("@") ? g.split("@")[0] === want.split("@")[0] && g.includes(want.split("@")[1]) : want === g;

interface Case {
  text: string;
  where: "PG" | "HQ";
  want: string;
  why: string;
  quoted?: string;
  route?: string[];
  /** A yes to the suggestion may carry the day the suggestion names: it is that game. */
  dayFromQuote?: boolean;
}
const CASES: Case[] = [
  // ── Every case of #515's check, now player_numbers ──
  { text: "@Match Time we can play with 12", where: "PG", want: "min12", why: "THE VETS CASE (#515)" },
  { text: "@Match Time minimum 12 players", where: "PG", want: "min12", why: "minimum (#515)" },
  { text: "@Match Time 12 kişiyle de oynarız", where: "PG", want: "min12", why: "TR (#515)" },
  { text: "@Match Time en az 13 kişi yeter", where: "PG", want: "min13", why: "TR minimum (#515; code refuses the odd 13)" },
  { text: "@Match Time we're happy to play one down, 13 is fine", where: "PG", want: "min13", why: "one down (#515; code refuses the odd 13)" },
  { text: "@Match Time back to full teams", where: "PG", want: "full", why: "undo (#515)" },
  { text: "@Match Time yine tam takım oynayalım", where: "PG", want: "full", why: "TR undo (#515)" },
  { text: "@Match Time how many do we need?", where: "PG", want: "not", why: "a question (#515)" },
  { text: "we're 12 tonight lads", where: "PG", want: "not", why: "a count, untagged (#515)" },
  { text: "@Match Time bu akşam kaç kişiyiz?", where: "PG", want: "not", why: "TR count question (#515)" },
  { text: "@Match Time we can play with 12", where: "HQ", want: "min12", why: "HQ: the Vets case (#515)" },
  { text: "@Match Time minimum 8 on Thursday", where: "HQ", want: "min8@thursday", why: "HQ with a day (#515, even now)" },
  { text: "@Match Time perşembe en az 8 kişi", where: "HQ", want: "min8@perşembe", why: "HQ TR with a day (#515, even now)" },
  { text: "@Match Time back to two full sides", where: "HQ", want: "full", why: "HQ undo (#515)" },
  // ── The range: the most players ──
  { text: "@Match Time we play 12 to 16", where: "PG", want: "min12-max16", why: "THE RANGE (in the prompt)" },
  { text: "@Match Time we can do anything from 12 up to 16 players", where: "PG", want: "min12-max16", why: "the range, held out" },
  { text: "@Match Time 12 ile 16 kişi arası oynuyoruz", where: "PG", want: "min12-max16", why: "TR range (in the prompt)" },
  { text: "@Match Time we play 6 to 8 a side", where: "PG", want: "min12-max16", why: "a side, doubled by code, held out" },
  { text: "@Match Time max 16 players", where: "HQ", want: "max16", why: "HQ maximum only, held out" },
  { text: "@Match Time en fazla 8'e 8 oynarız", where: "HQ", want: "max16", why: "HQ TR maximum a side, held out" },
  // ── One game a different size ──
  { text: "@Match Time make it 8 aside", where: "PG", want: "side8", why: "KEMAL'S CASE (in the prompt)" },
  { text: "@Match Time 6 kişilik oynayalım", where: "PG", want: "side6", why: "KEMAL'S TR CASE (in the prompt)" },
  { text: "@Match Time let's go 7 a side on Monday", where: "PG", want: "side7@monday", why: "a day, held out" },
  { text: "@Match Time can we make it 16 players this week", where: "PG", want: "side8", why: "a total, halved by code, held out" },
  { text: "@Match Time pazartesi 8'e 8 yapalım", where: "HQ", want: "side8@pazartesi", why: "HQ TR with a day, held out" },
  { text: "@Match Time switch to 6 a side", where: "HQ", want: "side6", why: "HQ, held out" },
  // ── A yes to MatchTime's suggestion ──
  { text: "yes", where: "PG", quoted: SUGGESTION, want: "side8", dayFromQuote: true, why: "DAVIDE'S YES (in the prompt)" },
  { text: "evet", where: "PG", quoted: SUGGESTION, want: "side8", dayFromQuote: true, why: "TR yes (in the prompt)" },
  { text: "yes go for it", where: "PG", quoted: SUGGESTION, want: "side8", dayFromQuote: true, why: "yes in other words, held out" },
  // ── Talk, not asked of MatchTime ──
  { text: "shall we go 8 aside next week lads?", where: "PG", want: "not", why: "a question to the others (router none)", route: ["none"] },
  { text: "8'e 8 mi oynasak?", where: "PG", want: "not", why: "TR question to the others", route: ["none"] },
];

async function main() {
  let pass = 0, exMiss = 0, routeMiss = 0;
  const only = process.env.ONLY;
  for (const [i, c] of CASES.entries()) {
    if (only && !c.text.includes(only)) continue;
    const id = `c${i}`;
    const reply = c.quoted ? quoteFromPi({ id: null, text: c.quoted, fromMatchTime: true }) : null;
    const r = await routeBatch(
      model,
      [{ id, authorName: "Davide", body: c.text, reply, ...(c.where === "HQ" ? { organisers: { context: organisersContext({ pending: [], recent: [] }), senderIsOrganiser: true } } : {}) }],
      { floor: true },
    );
    const route = r.routes[0]?.route ?? null;
    const ex = await extractForRoute(model, "admin_ops", {
      id,
      body: c.text,
      authorName: "Davide",
      tagged: /@match\s*time/i.test(c.text) || !!c.quoted,
      history: [],
      lastBotPost: null,
      reply,
      now: NOW,
    });
    const g = got(ex.facts.kind === "admin" ? ex.facts : null);
    const extractorOk = matches(c.want, g) || (c.dayFromQuote === true && g === `${c.want}@monday`);
    const reached = c.route ? c.route.includes(route ?? "") || (route === "admin_ops" && extractorOk) : c.want === "not" ? true : route === "admin_ops";
    if (extractorOk && reached) pass++;
    if (!extractorOk) exMiss++;
    if (!reached) routeMiss++;
    console.log(
      `${extractorOk && reached ? "PASS" : "FAIL"}  ${c.where} ${JSON.stringify(c.text)}${c.quoted ? " (reply to the suggestion)" : ""}  routed ${route}  extractor ${g}   (${c.why}; want ${c.want}${!reached ? "; ROUTER MISS" : ""}${!extractorOk ? "; EXTRACTOR MISS" : ""})`,
    );
  }
  console.log(`\n${pass} passed; extractor misses ${exMiss}; router misses ${routeMiss}. Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(exMiss + routeMiss > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
