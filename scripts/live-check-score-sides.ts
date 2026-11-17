/**
 * LIVE CHECK: the score, whatever the club calls its sides (2026-11-17,
 * Monday night vets), and the router's and the score extractor's existing
 * behaviours on the rewritten prompts, each case ONCE.
 *
 * The incident: "@Match Time bibs 9, no bibs 4" after the game routed
 * admin_ops and got "can't do that", twice. The router is now told a score
 * is awaited (`awaitedScoreLine`) and the score extractor reads THE GAME
 * (`gameContextLines`): the sides, what the club also calls them, and who
 * played on each (`score-sides.ts`).
 *
 * FOUR GROUPS, every person made up:
 *   router    single messages in the players' group under the awaited
 *             line (the incident, its variants, banter, attendance,
 *             instructions, the answer to the name question), one HQ
 *             message, and two without the line (existing behaviour);
 *   batch     the whole score path without a database (`runScoreBatch`
 *             with the real model, the real parser, the names placed,
 *             the real engine and composer; recording apply deps): the
 *             question, the answer, next week, a player's team, the
 *             unchanged forms, and the model NOT guessing a side;
 *   existing  every case in `score-live-cases.ts` (the club's history of
 *             result messages, corrections, answers, Turkish), through the
 *             extractor with THE GAME shown and the facts placed as the
 *             batch places them, graded by the real engine.
 *
 *   node --env-file=<repo>/.env ./node_modules/.bin/tsx scripts/live-check-score-sides.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Stops at MAX_USD
 * (default $1). No database, sends nothing. JSON=<path> writes every result.
 */
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch, type RouterMessage } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import { organisersContext } from "../src/lib/admin-group-context.ts";
import { awaitedScoreLine, gameContextLines, normaliseScoreFacts, type SideNames } from "../src/lib/pipeline/score-sides.ts";
import { runScoreBatch } from "../src/lib/score-engine-batch.ts";
import { world } from "../src/lib/pipeline/__tests__/helpers.ts";
import { SCORE_LIVE_CASES, describeOutcome, runScoreCase } from "../src/lib/pipeline/__tests__/score-live-cases.ts";
import type { Route, SquadState } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("the score side names live check");

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

const NOW = new Date();
const WHEN = "Mon 16 Nov 20:15";
const EN: [string, string] = ["Red", "Yellow"];
const BIBS: SideNames = { red: ["bibs"], yellow: ["no bibs"] };
const ASK_BIBS = `9 - 4, thanks. Which team was "bibs": Red or Yellow?`;
const ASK_BIBS_HINT = `9 - 4, thanks. Which team was "bibs" this time: Red or Yellow? Last time it was Red.`;

const results: Array<Record<string, unknown>> = [];
const tally: Record<string, [number, number]> = {};
function record(set: string, id: string, pass: boolean, line: string, extra: Record<string, unknown> = {}) {
  const t = (tally[set] ??= [0, 0]);
  t[1]++;
  if (pass) t[0]++;
  results.push({ set, id, pass, line, ...extra });
  console.log(`${pass ? "PASS" : "FAIL"}  ${set.padEnd(8)} ${id.padEnd(4)} ${line}`);
}

// ── router ───────────────────────────────────────────────────────────
type Want = Route | "att";
interface RouterCase {
  id: string;
  text: string;
  want: Want[];
  /** The awaited line shown: none, without names, or with the bibs names. */
  line?: "plain" | "names" | "off";
  hq?: boolean;
  /** The sender may answer MatchTime's open question, and replies to it. */
  answering?: boolean;
}
const ROUTER: RouterCase[] = [
  { id: "R1", text: "@Match Time bibs 9, no bibs 4", want: ["score"] },
  { id: "R2", text: "bibs 9, no bibs 4", want: ["score"] },
  { id: "R3", text: "@Match Time no bibs 9,  bibs 4", want: ["score"] },
  { id: "R4", text: "@Match Time we won 5-3", want: ["score"] },
  { id: "R5", text: "9-4 to Dan's team", want: ["score"] },
  { id: "R6", text: "Red 9 Yellow 4", want: ["score"] },
  { id: "R7", text: "@Match Time yelekliler 9 yeleksizler 4", want: ["score"] },
  { id: "R8", text: "@Match Time bibs 9, no bibs 4", want: ["score"], line: "names" },
  { id: "R9", text: "@Match Time red", want: ["score"], answering: true },
  { id: "R10", text: "great game lads", want: ["none"] },
  { id: "R11", text: "enjoyed that, see you all next week 💪", want: ["none"] },
  { id: "R12", text: "@Match Time cheers for sorting tonight 👍", want: ["none"] },
  { id: "R13", text: "Arsenal 2 Spurs 1", want: ["none"] },
  { id: "R14", text: "In", want: ["self_att"] },
  { id: "R15", text: "Rory OUT", want: ["other_att"] },
  { id: "R16", text: "@Match Time make it 8 aside", want: ["admin_ops"] },
  { id: "R17", text: "@Match Time make it 6 v 6 next week", want: ["admin_ops"] },
  { id: "R18", text: "@Match Time how many are in so far?", want: ["question"] },
  { id: "R19", text: "@Match Time make the teams please", want: ["balancer"] },
  { id: "R20", text: "@Match Time what was the score last week?", want: ["question"] },
  { id: "R21", text: "bibs 9 no bibs 4", want: ["score"], hq: true },
  { id: "R22", text: "5-3 to Yellows", want: ["score"], line: "off" },
  // Review of #620, 3: untagged banter with numbers inside the waiting window.
  { id: "RX1", text: "Red 2 Yellow 1 lol", want: ["none"] },
  { id: "RX2", text: "9pm next week?", want: ["none"] },
  { id: "RX3", text: "lost 3-0 on FIFA", want: ["none"] },
  { id: "R23", text: "great game lads", want: ["none"], line: "off" },
];

function routeOk(got: Route | undefined, want: Want[]): boolean {
  if (!got) return false;
  return want.some((w) => (w === "att" ? ["self_att", "other_att", "offer", "unsure"].includes(got) : w === got));
}

async function runRouter(c: RouterCase) {
  const line = c.line === "off" ? null : awaitedScoreLine({ when: WHEN, labels: EN, names: c.line === "names" ? BIBS : null });
  const msg: RouterMessage = {
    id: c.id,
    authorName: "Ava Stone",
    body: c.text,
    ...(c.hq
      ? {
          organisers: {
            context: organisersContext({ pending: [], recent: [], score: { kind: "result", day: "Mon 16 Nov", labels: EN } }),
            senderIsOrganiser: true,
          },
        }
      : {}),
    ...(c.answering ? { reply: { at: new Date(NOW.getTime() - 60_000), text: ASK_BIBS, topic: null, match: null, author: null } } : {}),
  };
  const r = await routeBatch(model, [msg], {
    ...(line && !c.hq ? { awaitedScoreLine: line } : {}),
    ...(c.answering ? { scoreAnswerIds: new Set([c.id]) } : {}),
    now: NOW,
  });
  const got = r.routes[0]?.route;
  const pass = routeOk(got, c.want);
  record("router", c.id, pass, `${JSON.stringify(c.text).padEnd(48)} -> ${String(got).padEnd(9)} (want ${c.want.join("|")}${c.hq ? ", HQ" : ""}${c.line ? `, line ${c.line}` : ""})`, {
    got,
    degradations: r.degradations.map((d) => d.detail),
  });
}

// ── the whole score path, no database ────────────────────────────────
const NAMES: Record<string, string> = { ava: "Ava Stone", ben: "Ben Cole", cal: "Cal Dunn", dan: "Dan Hale" };
function playedState(over: Partial<NonNullable<SquadState["completedMatch"]>> = {}, labels: [string, string] = EN, lang: "en" | "tr" = "en"): SquadState {
  const s = world({
    players: Object.keys(NAMES),
    admins: ["ava"],
    completedMatch: {
      id: "game-1",
      kickoffLabel: WHEN,
      participantUserIds: Object.keys(NAMES).map((k) => `u-${k}`),
      status: "TEAMS_PUBLISHED",
      kickoffAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
      teams: [
        { userId: "u-ava", team: "RED" },
        { userId: "u-ben", team: "RED" },
        { userId: "u-cal", team: "YELLOW" },
        { userId: "u-dan", team: "YELLOW" },
      ],
      teamLabels: labels,
      ...over,
    },
  });
  s.roster = s.roster.map((m) => ({ ...m, name: NAMES[m.userId.slice(2)] ?? m.name }));
  s.features.language = lang;
  return s;
}

type BatchWant = { red: number; yellow: number } | { ask: string } | "ask" | "report";
interface BatchCase {
  id: string;
  text: string;
  from?: "ava" | "cal";
  tagged?: boolean;
  state: () => SquadState;
  lastBotPost?: string;
  want: BatchWant;
  /** Names that must be remembered. */
  learns?: SideNames;
}
const pendingBibs = () =>
  playedState({
    pendingScore: { first: 9, second: 4, askedAt: new Date(NOW.getTime() - 60_000).toISOString(), askerUserId: "u-ava", name: "bibs", other: "no bibs" },
  });
const BATCH: BatchCase[] = [
  { id: "B1", text: "@Match Time bibs 9, no bibs 4", state: () => playedState(), want: { ask: "bibs" } },
  { id: "B2", text: "@Match Time red", state: pendingBibs, lastBotPost: ASK_BIBS, want: { red: 9, yellow: 4 }, learns: BIBS },
  { id: "B3", text: "@Match Time bibs were red", state: pendingBibs, lastBotPost: ASK_BIBS, want: { red: 9, yellow: 4 }, learns: BIBS },
  { id: "B4", text: "@Match Time yellow", state: pendingBibs, lastBotPost: ASK_BIBS, want: { red: 4, yellow: 9 } },
  // This game's own names (answered earlier tonight) record; an earlier
  // game's are a hint only, so the next week asks (review of #620).
  { id: "B5", text: "@Match Time bibs 9, no bibs 4", state: () => playedState({ sideNames: BIBS }), want: { red: 9, yellow: 4 } },
  { id: "B6", text: "bibs 9, no bibs 4", tagged: false, state: () => playedState({ sideNames: BIBS }), want: { red: 9, yellow: 4 } },
  { id: "B7", text: "@Match Time non bibs won 6-2", state: () => playedState({ sideNames: BIBS }), want: { ask: "non bibs" } },
  { id: "B5n", text: "@Match Time bibs 9, no bibs 4", state: () => playedState({ earlierSideNames: BIBS }), want: { ask: "bibs" } },
  { id: "B6n", text: "bibs 9, no bibs 4", tagged: false, state: () => playedState({ earlierSideNames: BIBS }), want: { ask: "bibs" } },
  {
    id: "B19",
    text: "@Match Time same",
    state: () => playedState({
      earlierSideNames: BIBS,
      pendingScore: { first: 9, second: 4, askedAt: new Date(NOW.getTime() - 60_000).toISOString(), askerUserId: "u-ava", name: "bibs", other: "no bibs" },
    }),
    lastBotPost: ASK_BIBS_HINT,
    want: { red: 9, yellow: 4 },
    learns: BIBS,
  },
  { id: "B8", text: "@Match Time no bibs 9,  bibs 4", state: () => playedState(), want: { ask: "no bibs" } },
  { id: "B9", text: "@Match Time Dan's team won 5-3", from: "cal", state: () => playedState(), want: { red: 3, yellow: 5 } },
  { id: "B10", text: "9-4 to Dan's team", tagged: false, state: () => playedState(), want: { red: 4, yellow: 9 } },
  { id: "B11", text: "@Match Time we won 5-3", state: () => playedState(), want: { red: 5, yellow: 3 } },
  { id: "B12", text: "@Match Time Red 9 Yellow 4", state: () => playedState(), want: { red: 9, yellow: 4 } },
  { id: "B13", text: "10-7", tagged: false, state: () => playedState(), want: "ask" },
  { id: "B14", text: "@Match Time bibs won 7-2", state: () => playedState(), want: { ask: "bibs" } },
  { id: "B15", text: "@Match Time yellows won 5-3", state: () => playedState({}, ["Lions", "Tigers"]), want: { ask: "yellows" } },
  { id: "B16", text: "@Match Time yelekliler 9 yeleksizler 4", state: () => playedState({}, ["Kırmızı", "Sarı"], "tr"), want: { ask: "yelekliler" } },
  // Review of #620, 2: a captain on both sides, or in neither line-up: ask.
  {
    id: "B17",
    text: "@Match Time Dan's team won 5-3",
    state: () => {
      const st = playedState();
      st.roster = st.roster.map((m) => (m.userId === "u-ava" ? { ...m, name: "Dan Hale" } : m));
      return st;
    },
    want: { ask: "dan's team" },
  },
  { id: "B18", text: "@Match Time Zed's team won 5-3", state: () => playedState(), want: { ask: "zed's team" } },
  // Review of #620, 3: untagged banter with numbers, from a participant,
  // inside the waiting window, as if the router had sent it to score.
  { id: "X1", text: "Red 2 Yellow 1 lol", from: "cal", tagged: false, state: () => playedState(), want: "report" },
  { id: "X2", text: "9pm next week?", from: "cal", tagged: false, state: () => playedState(), want: "report" },
  { id: "X3", text: "lost 3-0 on FIFA", from: "cal", tagged: false, state: () => playedState(), want: "report" },
];

async function runBatch(c: BatchCase) {
  const state = c.state();
  const recorded: Array<{ red: number; yellow: number }> = [];
  const asked: Array<{ name?: string }> = [];
  const learned: SideNames[] = [];
  const from = c.from ?? "ava";
  const tagged = c.tagged ?? true;
  const res = await runScoreBatch({
    orgId: "org-live",
    now: NOW,
    messages: [
      {
        waMessageId: c.id,
        body: c.text,
        authorName: NAMES[from],
        senderUserId: `u-${from}`,
        senderName: NAMES[from],
        tagged,
        taggedExplicitly: tagged,
        route: "score",
        gated: false,
      },
    ],
    history: c.lastBotPost ? [{ author: "MatchTime", body: c.lastBotPost }] : [],
    enabled: new Set(["score"]),
    deps: {
      model,
      loadState: async () => state,
      recordScore: async (a) => void recorded.push({ red: a.red, yellow: a.yellow }),
      reconcileElo: async () => ({ moved: 0 }),
      recordScoreAsk: async (a) => void asked.push({ name: a.name }),
      recordSideNames: async (a) => void learned.push(a.names),
    },
  });
  const out = res.outcomes.get(c.id);
  const got = recorded[0]
    ? `Red ${recorded[0].red}, Yellow ${recorded[0].yellow}`
    : asked[0]
      ? asked[0].name
        ? `asked about "${asked[0].name}"`
        : "asked which team won"
      : "nothing";
  let pass: boolean;
  if (c.want === "report") pass = true;
  else if (c.want === "ask") pass = !recorded[0] && !!asked[0] && !asked[0].name;
  else if ("ask" in c.want) pass = !recorded[0] && asked[0]?.name?.toLowerCase() === c.want.ask;
  else pass = recorded[0]?.red === c.want.red && recorded[0]?.yellow === c.want.yellow;
  if (c.learns) pass = pass && JSON.stringify(learned[0]) === JSON.stringify(c.learns);
  const wanted =
    c.want === "report"
      ? "reported, not graded"
      : c.want === "ask"
        ? "asked which team won"
        : "ask" in c.want
          ? `asked about "${c.want.ask}"`
          : `Red ${c.want.red}, Yellow ${c.want.yellow}`;
  record("batch", c.id, pass, `${JSON.stringify(c.text).padEnd(48)} -> ${got} (want ${wanted})${learned[0] ? `; learned ${JSON.stringify(learned[0])}` : ""}\n        reply: ${out?.reply ?? "(none)"}`, {
    got,
    reply: out?.reply ?? null,
    learned: learned[0] ?? null,
    reasoning: out?.reasoning,
    degradations: res.degradations,
  });
}

// ── the existing score cases ─────────────────────────────────────────
async function runExisting(c: (typeof SCORE_LIVE_CASES)[number]) {
  const labels = c.labels ?? EN;
  const game = gameContextLines({
    when: WHEN,
    labels,
    names: null,
    players: { red: ["Ava Stone", "Ben Cole"], yellow: ["Cal Dunn", "Dan Hale"] },
    awaiting: !c.recorded,
  });
  const res = await extractForRoute(model, "score", {
    id: c.id,
    body: c.body,
    authorName: c.sender === "yellow" ? "Cal Dunn" : "Ava Stone",
    tagged: c.tagged ?? false,
    history: [],
    lastBotPost: c.lastBotPost ?? null,
    game,
    now: NOW,
  });
  let got = "no score facts";
  let pass = false;
  if (res.facts.kind === "score") {
    const { facts } = normaliseScoreFacts(res.facts, { labels, names: null, senderTeam: c.sender === "yellow" ? "YELLOW" : "RED" });
    const outcome = runScoreCase(c, facts);
    got = describeOutcome(outcome);
    pass = JSON.stringify(outcome) === JSON.stringify(c.expect);
  }
  record("existing", c.id, pass, `${JSON.stringify(c.body).slice(0, 60).padEnd(62)} -> ${got} (want ${describeOutcome(c.expect)})`, {
    got,
    facts: res.facts,
  });
}

async function main() {
  for (const c of ROUTER) await runRouter(c);
  for (const c of BATCH) await runBatch(c);
  for (const c of SCORE_LIVE_CASES) await runExisting(c);
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
