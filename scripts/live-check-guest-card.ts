/**
 * BRINGING A GUEST BY CONTACT CARD: THE PAID CHECK (2026-11-17). Dev key
 * only, each case ONCE (the cheap plan), capped at $1.
 *
 *   npx tsx --env-file=.env scripts/live-check-guest-card.ts
 *
 * Part 1, the guest reader (`guest-card/reader.ts`, a new prompt): the
 * exact production prompt and user turn on the real model, for an
 * organiser's words beside a shared card, and a typed name and number. It
 * passes when the reading would make MatchTime do the right thing: an add
 * at or above the floor, for the right game, with the name and number as
 * written; or no add (anything below the floor adds nobody). A HARMFUL
 * miss is a confident add that was not asked for.
 *
 * Part 2, the guest's questions by DM (`unified-answer.ts`, its prompt
 * unchanged; its CONTEXT gains the guest's game, `guest-card/context.ts`):
 * the real answer step, DM audience, with the block, for the questions a
 * guest asks. Each answer is printed with what it must carry.
 *
 * Made-up people, 07700 900xxx numbers. No database, sends nothing.
 */
import { config as loadEnv } from "dotenv";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { londonDateTimeToUtc } from "../src/lib/london-time.ts";
import { GUEST_ADD_FLOOR, readGuestAdd, type GuestAddContext } from "../src/lib/guest-card/reader.ts";
import { phoneWrittenIn } from "../src/lib/guest-card/rules.ts";
import { formatGuestGameBlock } from "../src/lib/guest-card/context.ts";
import { answerUnified, type UnifiedAnswerInput } from "../src/lib/pipeline/unified-answer.ts";
import { world } from "../src/lib/pipeline/__tests__/helpers.ts";

loadEnv();
const MAX_USD = 1;
spendDevApiKeyOrExit("the guest card live check");

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

// Tuesday 17 November 2026, 14:05; the club plays tonight and on Friday.
const NOW = londonDateTimeToUtc("2026-11-17", "14:05");
const TONIGHT = londonDateTimeToUtc("2026-11-17", "20:00");
const FRIDAY = londonDateTimeToUtc("2026-11-20", "20:00");
const GAMES = [
  { club: "Riverside FC", kickoff: TONIGHT },
  { club: "Riverside FC", kickoff: FRIDAY },
];
const ONE_CARD = [{ name: "Abu Ayoub" }];

interface Case {
  text: string;
  cards: GuestAddContext["cards"];
  add: boolean;
  /** The game it must pick (1 tonight, 2 Friday); 0: any, the soonest is used. */
  game?: number;
  name?: string;
  phone?: string;
}

const CASES: Case[] = [
  // With a card shared
  { text: "add him for tonight", cards: ONE_CARD, add: true, game: 1 },
  { text: "he's playing tonight", cards: ONE_CARD, add: true, game: 1 },
  { text: "he's in", cards: ONE_CARD, add: true },
  { text: "add him for Friday please", cards: ONE_CARD, add: true, game: 2 },
  { text: "bu akşam oynuyor, ekle", cards: ONE_CARD, add: true, game: 1 },
  { text: "cuma oynuyor", cards: ONE_CARD, add: true, game: 2 },
  { text: "add these 2 boys for tonight", cards: [{ name: "Abu Ayoub" }, { name: "Sami Kaya" }], add: true, game: 1 },
  { text: "who's this?", cards: ONE_CARD, add: false },
  { text: "might bring him next week", cards: ONE_CARD, add: false },
  { text: "belki haftaya getiririm", cards: ONE_CARD, add: false },
  { text: "he can't make it tonight", cards: ONE_CARD, add: false },
  // No card: a typed name and number
  { text: "Abu Ayoub 07700 900123 is playing tonight", cards: [], add: true, game: 1, name: "Abu Ayoub", phone: "07700 900123" },
  { text: "Sami 07700 900456 cuma oynuyor", cards: [], add: true, game: 2, name: "Sami", phone: "07700 900456" },
  { text: "put Can Demir in for Friday, his number is 07700 900789", cards: [], add: true, game: 2, name: "Can Demir", phone: "07700 900789" },
  { text: "Abu's number is 07700 900123", cards: [], add: false },
  { text: "call me on 07700 900321 if anyone drops", cards: [], add: false },
];

async function part1(): Promise<{ pass: number; harmful: number }> {
  let pass = 0;
  let harmful = 0;
  console.log("\n=== Part 1: the guest reader ===\n");
  for (const c of CASES) {
    const r = await readGuestAdd(c.text, { now: NOW, games: GAMES, cards: c.cards, quotedCard: false, senderName: "Oscar Owner" }, { model });
    const adds = r.add && r.confidence >= GUEST_ADD_FLOOR;
    let ok = adds === c.add;
    const why: string[] = [];
    if (ok && c.add) {
      if (c.game && (r.game || 1) !== c.game) {
        ok = false;
        why.push(`game ${r.game}, wanted ${c.game}`);
      }
      if (c.name && r.name !== c.name) {
        ok = false;
        why.push(`name "${r.name}", wanted "${c.name}"`);
      }
      if (c.phone && !(r.phone && phoneWrittenIn(r.phone, c.text))) {
        ok = false;
        why.push(`phone "${r.phone}" not the one written`);
      }
    }
    if (adds && !c.add) harmful++;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text)} cards=${c.cards.length} -> add=${r.add} (${r.confidence}) game=${r.game} name=${JSON.stringify(r.name)} phone=${JSON.stringify(r.phone)}${why.length ? `  [${why.join("; ")}]` : ""}`);
  }
  return { pass, harmful };
}

const BLOCK = formatGuestGameBlock(
  {
    club: "Riverside FC",
    kickoff: TONIGHT,
    format: "Football 7-a-side",
    venue: "Powerleague Shoreditch",
    address: "12 Whiston Road, London E2 8BN",
    mapUrl: "https://www.google.com/maps/search/?api=1&query=51.5229%2C-0.0757&query_place_id=ChIJexample",
    fee: { kind: "amount", amount: "£6" },
    monthly: false,
  },
  "CONFIRMED",
);

const QUESTIONS: Array<{ q: string; lang: "en" | "tr"; must: RegExp[]; mustNot?: RegExp[] }> = [
  { q: "what time is it and where?", lang: "en", must: [/20:00|8 ?pm/i, /Powerleague Shoreditch/] },
  { q: "what's the address?", lang: "en", must: [/12 Whiston Road/] },
  { q: "how much is it?", lang: "en", must: [/£6/] },
  { q: "who else is playing?", lang: "en", must: [/Kemal|Sait|Idris/] },
  { q: "is there parking?", lang: "en", must: [/.+/], mustNot: [/yes,? there(?:'s| is) (?:free )?parking/i] },
  { q: "maç kaçta, nerede?", lang: "tr", must: [/20[:.]00/, /Powerleague Shoreditch/] },
];

async function part2(): Promise<number> {
  console.log("\n=== Part 2: the guest's questions by DM (unified answer, DM audience, with his game) ===\n");
  console.log(BLOCK, "\n");
  let pass = 0;
  for (const c of QUESTIONS) {
    const st = world({ confirmed: ["kemal", "sait", "idris", "abu"], players: ["kemal", "elvin", "sait", "idris", "abu"] });
    const input: UnifiedAnswerInput = {
      audience: "dm",
      state: {
        ...st,
        venue: "Powerleague Shoreditch",
        kickoffLabel: "Tue 20:00",
        matchLabel: "Tue 17 Nov, 20:00",
        club: { collectorName: "Elvin Aliyev", feePerPlayer: 6, feeSplitTotal: false, teamsReady: "18:00" },
        features: { ...st.features, language: c.lang },
      },
      squadKnown: true,
      stats: null,
      person: { userId: "u-abu", self: true },
      results: null,
      payments: null,
      ratingProgress: null,
      clubFacts: null,
      squadMode: "weekly",
      own: [BLOCK],
      dmChat: "(MatchTime has not messaged them about anything else.)",
      history: [],
      lastBotPost: null,
      reply: null,
      now: NOW,
      question: c.q,
      askerUserId: "u-abu",
      askerName: "Abu Ayoub",
      askerIsAdmin: false,
    };
    const g = await answerUnified({ ...input, model });
    const text = "rejected" in g.result ? `(rejected: ${g.result.rejected})` : g.result.text;
    const ok = c.must.every((r) => r.test(text)) && !(c.mustNot ?? []).some((r) => r.test(text)) && !/07700|447700/.test(text);
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.q)}\n      ${text.replace(/\n/g, "\n      ")}\n`);
  }
  return pass;
}

async function main(): Promise<void> {
  const p1 = await part1();
  const p2 = await part2();
  console.log(`\nPart 1: ${p1.pass}/${CASES.length} right, ${p1.harmful} harmful (a confident add nobody asked for).`);
  console.log(`Part 2: ${p2}/${QUESTIONS.length} answers carry what they must.`);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (cap $${MAX_USD}).`);
}

main().catch((err) => {
  console.error(err);
  console.log(`Model calls: ${calls}. Cost: $${usd.toFixed(4)} (cap $${MAX_USD}).`);
  process.exit(1);
});
