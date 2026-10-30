/**
 * LIVE CHECK FOR P1 OF THE "NO STRING PARSING" SWEEP (2026-10-30).
 *
 * ⚠️ THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only
 * (ANTHROPIC_API_KEY_DEV); it refuses without it and stops at MAX_USD.
 *
 * Each case is a behaviour a regex used to decide and the model decides
 * now, run ONCE (Kemal's cheap plan):
 *   - the router: the bot named without an @ (to_bot), bare IN/OUT and
 *     "@Name IN" with no floor, the "who do you mean?" reply, the
 *     "which team won?" answer and a score correction shown as facts;
 *   - the attendance extractor: a joking drop (low confidence), unnamed
 *     and whole-group references (personNamed false);
 *   - the score extractor: an answer to "which team won?" and chatter;
 *   - the admin extractor: the reminder time as a London date and time;
 *   - the question extractor: a clarification reply read against the
 *     original question.
 *
 *   npx tsx scripts/live-check-no-parsing-p1.ts
 */
import { config as loadEnv } from "dotenv";
import { writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch, type RouterMessage } from "../src/lib/pipeline/router.ts";
import { extractForRoute } from "../src/lib/pipeline/extractors.ts";
import type { Route } from "../src/lib/pipeline/types.ts";
import type { StatsClarification } from "../src/lib/pipeline/awaiting-answer.ts";
import { decide } from "../src/lib/pipeline/engine.ts";
import { world, msg as engineMsg } from "../src/lib/pipeline/__tests__/helpers.ts";

loadEnv({ quiet: true });
const MAX_USD = 0.2;
spendDevApiKeyOrExit("the P1 no-parsing live check");

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

// Tue 20 Oct 2026, 19:00 London (BST); the clocks go back on Sun 25 Oct.
const NOW = new Date("2026-10-20T18:00:00Z");
const results: Array<{ id: string; pass: boolean; got: string; want: string }> = [];
const record = (id: string, pass: boolean, got: unknown, want: string) => {
  results.push({ id, pass, got: JSON.stringify(got), want });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}: got ${JSON.stringify(got)}; want ${want}`);
};

const CLAR: StatsClarification = {
  id: "am-1",
  orgId: "org",
  askerUserId: "u-kemal",
  askerName: "Kemal Ediz",
  questionBody: "@Match Time Zork's chemistry",
  askedAt: new Date(NOW.getTime() - 5 * 60_000),
};

interface RouterCase {
  id: string;
  msg: Omit<RouterMessage, "id">;
  want: Route[];
  toBot?: boolean;
  opts?: { clar?: boolean; scoreAnswer?: boolean; correction?: boolean };
}

const ROUTER_CASES: RouterCase[] = [
  { id: "B1-name-no-at", msg: { authorName: "Ali", body: "MatchTime who runs this club?" }, want: ["question"], toBot: true },
  { id: "B1-about-the-bot", msg: { authorName: "Kemal", body: "please do not forget to rate the players via the link from Matchtime DM'ed to you" }, want: ["none"], toBot: false },
  { id: "B1-tagged", msg: { authorName: "Ali", body: "@Match Time who's in?" }, want: ["question"], toBot: true },
  { id: "F-bare-in", msg: { authorName: "Pete", body: "in" }, want: ["self_att"] },
  { id: "F-bare-IN-emoji", msg: { authorName: "Pete", body: "IN 👍" }, want: ["self_att"] },
  { id: "F-bare-out", msg: { authorName: "Dan", body: "out" }, want: ["self_att"] },
  { id: "F-var", msg: { authorName: "Erdal", body: "var" }, want: ["self_att"] },
  { id: "F-yokum", msg: { authorName: "Erdal", body: "yokum" }, want: ["self_att"] },
  { id: "F-mention-in", msg: { authorName: "Kemal", body: "@Ehtisham Ul Haq In" }, want: ["other_att"] },
  { id: "F-mention-out", msg: { authorName: "Kemal", body: "@Zair Malik out" }, want: ["other_att"] },
  { id: "C-name-reply", msg: { authorName: "Kemal Ediz", body: "Idris" }, want: ["question"], opts: { clar: true } },
  { id: "C-in-reply", msg: { authorName: "Kemal Ediz", body: "I'm in" }, want: ["self_att"], opts: { clar: true } },
  { id: "S-answer-en", msg: { authorName: "Elvin", body: "Yellow" }, want: ["score"], opts: { scoreAnswer: true } },
  { id: "S-answer-tr", msg: { authorName: "Elvin", body: "sarılar" }, want: ["score"], opts: { scoreAnswer: true } },
  { id: "S-corr-swap", msg: { authorName: "Kemal", body: "@Match Time other way round" }, want: ["score"], opts: { correction: true } },
  { id: "S-corr-tr", msg: { authorName: "Kemal", body: "@Match Time yanlış, kırmızı 6 sarı 9" }, want: ["score"], opts: { correction: true } },
  { id: "S-corr-not-out", msg: { authorName: "Kemal", body: "@Match Time no, I'm out" }, want: ["self_att"], opts: { correction: true } },
];

async function routerCases(): Promise<void> {
  for (const c of ROUTER_CASES) {
    const id = c.id;
    const r = await routeBatch(model, [{ id, ...c.msg }], {
      now: NOW,
      ...(c.opts?.clar ? { clarifications: [CLAR] } : {}),
      ...(c.opts?.scoreAnswer ? { scoreAnswerIds: new Set([id]) } : {}),
      ...(c.opts?.correction ? { scoreCorrectionIds: new Set([id]) } : {}),
    });
    const got = r.routes[0];
    const routeOk = c.want.includes(got.route) && got.source === "model";
    const botOk = c.toBot === undefined || (got.toBot === true) === c.toBot;
    record(`router ${id}`, routeOk && botOk, { route: got.route, source: got.source, toBot: !!got.toBot }, `${c.want.join("|")}${c.toBot === undefined ? "" : ` to_bot ${c.toBot}`}`);
  }
}

const base = { tagged: false, history: [], lastBotPost: null, now: NOW };

async function extractorCases(): Promise<void> {
  // A joking drop: the claim is reported, at a confidence under the engine's floor (0.7).
  {
    const r = await extractForRoute(model, "other_att", { ...base, id: "E1", authorName: "Pete", body: "Zeeshan is out lol vote him out" });
    const c = r.facts.kind === "attendance" ? r.facts.claims.find((x) => x.subject === "other") : undefined;
    record("attendance E1-joke-low-confidence", !c || c.confidence < 0.7, c ? { confidence: c.confidence, polarity: c.polarity } : "no claim", "confidence < 0.7 or no claim");
  }
  {
    const r = await extractForRoute(model, "other_att", { ...base, id: "E2", authorName: "Pete", body: "Sam can't make it tonight" });
    const c = r.facts.kind === "attendance" ? r.facts.claims.find((x) => x.subject === "other") : undefined;
    record("attendance E2-plain-drop-kept", !!c && c.polarity === "out" && c.confidence >= 0.7, c ? { confidence: c.confidence, polarity: c.polarity } : "no claim", "out, confidence >= 0.7");
  }
  for (const [id, body] of [["E3-everyone", "@everyone in"], ["E4-brother", "my brother can play if needed"]] as const) {
    const r = await extractForRoute(model, "other_att", { ...base, id, authorName: "Amir", body });
    const others = r.facts.kind === "attendance" ? r.facts.claims.filter((x) => x.subject === "other") : [];
    record(`attendance ${id}`, others.every((x) => !x.personNamed), others.map((x) => ({ ref: x.personRef, named: x.personNamed })), "no named other");
  }
  // Score: an answer to "which team won?", and the asker's chatter.
  const ASK = "10 - 7 to which team?";
  for (const [id, body, want] of [
    ["S1-answer", "Yellow", "Yellow"],
    ["S2-chatter", "yellow bibs stink mate, reds deserved it anyway", ""],
    ["S3-question", "Yellow?", ""],
  ] as const) {
    const r = await extractForRoute(model, "score", { ...base, id, authorName: "Elvin", body, lastBotPost: ASK });
    const w = r.facts.kind === "score" ? (r.facts.winner ?? "") : "(not score)";
    record(`score ${id}`, want ? w.toLowerCase().includes(want.toLowerCase()) : w === "", { winner: w }, want ? `winner ${want}` : "no winner");
  }
  // Reminders: the London date and time, from NOW.
  for (const [id, body, want] of [
    ["A1-tomorrow-6", "@Match Time remind me tomorrow at 6 to bring the bibs", "2026-10-21 18:00"],
    ["A2-monday-morning-after-dst", "@Match Time remind me on Monday morning", "2026-10-26 09:00"],
    ["A3-tr", "@Match Time yarın akşam 8'de hatırlat", "2026-10-21 20:00"],
    ["A4-later", "@Match Time remind me later", ""],
  ] as const) {
    const r = await extractForRoute(model, "admin_ops", { ...base, tagged: true, id, authorName: "Zair", body });
    const at = r.facts.kind === "admin" ? (r.facts.remindAt ?? "") : "(not admin)";
    record(`admin ${id}`, at === want, { action: r.facts.kind === "admin" ? r.facts.action : null, remindAt: at }, want || "no remindAt");
  }
  // A clarification reply read against the original question.
  {
    const r = await extractForRoute(model, "question", {
      ...base,
      tagged: true,
      id: "Q1",
      authorName: "Kemal Ediz",
      body: "Idris",
      clarifying: CLAR.questionBody,
    });
    const ref = r.facts.kind === "question" ? r.facts.personRef : "(not question)";
    record("question Q1-clarified", (ref ?? "").toLowerCase().includes("idris"), { personRef: ref }, "personRef Idris");
  }
}

const LIST = "Monday 7-a-side\n1. Kemal\n2. Elvin\n3. Raihan\n4. Tom\n5. Ali\n6. Sam\n7. Kai\n8. Najib (added)";

const ROUTER_CASES_2: RouterCase[] = [
  { id: "T-elvin-raihan-2026-09-08", msg: { authorName: "Kemal", body: "@Match Time do not regenerate the teams. Instead swap Elvin with Raihan and share us the teams" }, want: ["balancer"] },
  { id: "T-swap-me", msg: { authorName: "Raihan", body: "@Match Time swap me with Elvin" }, want: ["balancer"] },
  { id: "T-swap-tr", msg: { authorName: "Elvin", body: "Raihan ile yer değiştirelim" }, want: ["balancer"] },
  { id: "T-clear-incident", msg: { authorName: "Kemal", body: "@Match Time delete these teams, early to form them, there is still 5 days" }, want: ["balancer"] },
  { id: "T-colours-tr", msg: { authorName: "Erdal", body: "@Match Time renkleri değiştir, takımlar aynı kalsın" }, want: ["balancer"] },
  { id: "T-replacement-stays", msg: { authorName: "Kemal", body: "Amir in for Zeeshan" }, want: ["other_att"] },
  { id: "T-bench-is-not-a-team", msg: { authorName: "Elvin", body: "@Match Time move Salman to bench, keep Talha" }, want: ["other_att"] },
  { id: "T-bench-is-not-a-team-2", msg: { authorName: "Elvin", body: "@Match Time put Mustafa on the bench for tonight" }, want: ["other_att"] },
  { id: "T-replacement-tr-stays", msg: { authorName: "Kemal", body: "Najib çıkıyor, Mojib giriyor" }, want: ["other_att"] },
];

async function routerCases2(): Promise<void> {
  for (const c of ROUTER_CASES_2) {
    const r = await routeBatch(model, [{ id: c.id, ...c.msg }], { now: NOW });
    const got = r.routes[0];
    record(`router ${c.id}`, c.want.includes(got.route) && got.source === "model", { route: got.route }, c.want.join("|"));
  }
  for (const [id, body, want] of [
    ["L-numbered-list", LIST, true],
    ["L-sentence", "Sam can't make it tonight, Kai and Ali are in", false],
  ] as const) {
    const r = await routeBatch(model, [{ id, authorName: "Kemal", body }], { now: NOW });
    const got = r.routes[0];
    record(`router ${id}`, (got.pastedList === true) === want && (want ? got.route === "other_att" : true), { route: got.route, pastedList: !!got.pastedList }, `pasted_list ${want}`);
  }
}

async function extractorCases2(): Promise<void> {
  const TEAMS = "Red: Kemal, Elvin, Tom\nYellow: Raihan, Ali, Sam";
  for (const [id, body, check, want] of [
    ["X-colours-tr", "@Match Time renkleri değiştir, takımlar aynı kalsın", (f: any) => f.action === "swap" && f.swapSides === true, "swap, swapSides"],
    ["X-colours-en", "@Match Time swap the colours, same teams", (f: any) => f.action === "swap" && f.swapSides === true, "swap, swapSides"],
    ["X-clear-incident", "@Match Time delete these teams, early to form them, there is still 5 days", (f: any) => f.action === "clear", "clear"],
    ["X-clear-tr", "@Match Time takımları kaldır, daha erken", (f: any) => f.action === "clear", "clear"],
    ["X-rename-stays", "@Match Time call the teams Lions and Tigers", (f: any) => f.action === "rename", "rename"],
    ["X-elvin-raihan", "@Match Time do not regenerate the teams. Instead swap Elvin with Raihan and share us the teams", (f: any) => f.action === "swap" && (f.moves ?? []).length === 2, "swap, two moves"],
  ] as const) {
    const r = await extractForRoute(model, "balancer", { ...base, tagged: true, id, authorName: "Kemal", body, lastBotPost: TEAMS });
    const f = r.facts as any;
    record(`teams ${id}`, f.kind === "teams" && check(f), { action: f.action, swapSides: f.swapSides, moves: f.moves }, want);
  }
  for (const [id, body, wantTeams, wantOut] of [
    ["AT-out-and-swap", "@Match Time count me out tonight, and swap Tom with Ali", true, true],
    ["AT-swap-only", "@Match Time swap me with Tom", true, false],
    ["AT-question-not-teams", "Kai is out now. @Match Time what's the list?", false, false],
  ] as const) {
    const r = await extractForRoute(model, "self_att", { ...base, tagged: true, id, authorName: "Raihan", body });
    const f = r.facts as any;
    const teams = f.kind === "attendance" && f.sideRequests.includes("teams");
    const senderOut = f.kind === "attendance" && f.claims.some((c: any) => c.subject === "sender" && c.polarity === "out");
    const noSwapClaims = f.kind === "attendance" && !f.claims.some((c: any) => c.subject === "other" && /tom|ali/i.test(c.personRef) && c.polarity !== "out");
    record(`attendance ${id}`, teams === wantTeams && (!wantOut || senderOut) && noSwapClaims, { sideRequests: f.sideRequests, claims: (f.claims ?? []).map((c: any) => [c.subject, c.personRef, c.polarity]) }, `teams ${wantTeams}${wantOut ? ", sender out" : ""}, no swap claims`);
  }
}

/** Round 3 (the review of #476): each case once. */
async function reviewCases(): Promise<void> {
  // M6: the shapes the floor used to catch, and one it must not rescue.
  for (const [id, body, want] of [
    ["F-im-in", "I'm in", ["self_att"]],
    ["F-innn", "innn", ["self_att"]],
    ["F-cant-make-it", "can't make it", ["self_att"]],
    ["F-ben-varim", "ben varım", ["self_att"]],
    ["F-gelemiyorum", "gelemiyorum", ["self_att"]],
    ["F-several-mentions", "@Ali Khan @Can Demir @Tom Hill in", ["other_att"]],
    ["F-crown-emoji", "@Jesse 👑 IN", ["other_att"]],
  ] as const) {
    const r = await routeBatch(model, [{ id, authorName: "Pete", body }], { now: NOW });
    record(`router ${id}`, (want as readonly string[]).includes(r.routes[0].route), { route: r.routes[0].route }, want.join("|"));
  }
  {
    const r = await extractForRoute(model, "other_att", { ...base, id: "F-zeeshan", authorName: "Pete", body: "Zeeshan is out 😂" });
    const c = r.facts.kind === "attendance" ? r.facts.claims.find((x) => x.subject === "other") : undefined;
    record("attendance F-zeeshan-not-a-rescue", !c || c.confidence < 0.7, c ? { confidence: c.confidence } : "no claim", "a joke: confidence < 0.7 or no claim");
  }
  // M5: with a recorded result as MatchTime's last post, an attendance
  // message is still attendance.
  for (const [id, body, want] of [
    ["S-tom-out-with-result", "@Match Time Tom out", "other_att"],
    ["S-im-out-with-result", "@Match Time I'm out", "self_att"],
  ] as const) {
    const r = await routeBatch(model, [{ id, authorName: "Kemal", body }], { now: NOW, scoreCorrectionIds: new Set([id]) });
    record(`router ${id}`, r.routes[0].route === want, { route: r.routes[0].route }, want);
  }
  // H1: the kind of person each ref is.
  for (const [id, body, want] of [
    ["K-everyone", "@everyone in", "group"],
    ["K-the-lads", "the lads are in tonight", "group"],
    ["K-brother", "my brother can play if needed", "relation"],
    ["K-amirs-brother", "Amir's brother is in", "relation"],
    ["K-someone", "someone can take my spot", "placeholder"],
    ["K-named", "my brother Shahrokh can play", "named"],
  ] as const) {
    const r = await extractForRoute(model, "other_att", { ...base, id, authorName: "Amir", body });
    const others = r.facts.kind === "attendance" ? r.facts.claims.filter((x) => x.subject === "other") : [];
    const ok = want === "named" ? others.some((x) => x.personKind === "named" && /shahrokh/i.test(x.personRef)) : others.every((x) => x.personKind !== "named");
    record(`attendance ${id}`, ok, others.map((x) => [x.personRef, x.personKind]), want === "named" ? "Shahrokh named" : `no named other (${want})`);
  }
  // H2: a bench asked for, or not.
  const FULL = "Confirmed (14/14):\n1. Kemal\n2. Elvin\n3. Erdal\n4. Sait\n5. Tom\n6. Ali\n7. Can\n8. Mo\n9. Ibo\n10. Kai\n11. Sam\n12. Raj\n13. Dan\n14. Joe";
  for (const [id, body, want] of [
    ["B-bare-in-full", "in", false],
    ["B-put-me-on-bench", "put me on the bench, let Habib play", true],
    ["B-in-for-bench", "In. For bench👍", true],
    ["B-yedek", "yedekte kalayım", true],
  ] as const) {
    const r = await extractForRoute(model, "self_att", { ...base, id, authorName: "Erdal", body, lastBotPost: FULL });
    const c = r.facts.kind === "attendance" ? r.facts.claims.find((x) => x.subject === "sender") : undefined;
    const asked = !!c && c.polarity === "bench" && c.benchAsked === true;
    record(`attendance ${id}`, asked === want, c ? { polarity: c.polarity, benchAsked: c.benchAsked } : "no claim", `benchAsked ${want}`);
  }
  // H3: the asker's chatter within 30 minutes records nothing, whatever the
  // extractor reads (not a reply to MatchTime's question, no real tag).
  const ASK = "10 - 7 to which team?";
  for (const [id, body] of [
    ["M2i", "yellow bibs stink mate, whoever takes them home wash them. reds deserved it anyway"],
    ["M2j", "honestly yellows always win when Najib plays"],
    ["M2k", "MatchTime can you put me on yellow next week, reds won again"],
  ] as const) {
    const r = await extractForRoute(model, "score", { ...base, id, authorName: "Elvin", body, lastBotPost: ASK });
    const state = world({
      admins: ["kemal"],
      completedMatch: {
        id: "done-1",
        participantUserIds: ["u-kemal", "u-elvin"],
        teams: [{ userId: "u-kemal", team: "RED" as const }, { userId: "u-elvin", team: "YELLOW" as const }],
        kickoffAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
        pendingScore: { first: 10, second: 7, askedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), askerUserId: "u-elvin" },
      },
    });
    const d = decide({ now: NOW, state, messages: [engineMsg({ from: "elvin", body, route: "score", facts: r.facts, tagged: id === "M2k" })] });
    const scores = d.writes.filter((w) => w.kind === "score");
    record(`score ${id}-no-record`, scores.length === 0, { winner: r.facts.kind === "score" ? r.facts.winner : null, recorded: scores.length }, "nothing recorded");
  }
  // M4: a clarification only when the reply answers it.
  for (const [id, body, want] of [
    ["Q-answers", "I mean Idris", true],
    ["Q-new-question", "@Match Time how many are we?", false],
  ] as const) {
    const r = await extractForRoute(model, "question", { ...base, tagged: true, id, authorName: "Kemal Ediz", body, clarifying: CLAR.questionBody });
    const f = r.facts as { kind: string; answersClarification?: boolean; personRef?: string | null; topic?: string };
    const ok = (f.answersClarification === true) === want && (!want || /idris/i.test(f.personRef ?? ""));
    record(`question ${id}`, ok, { answersClarification: f.answersClarification === true, topic: f.topic, personRef: f.personRef }, `answersClarification ${want}`);
  }
}

async function main(): Promise<void> {
  if (process.env.P1_ONLY === "3") {
    await reviewCases();
  } else if (process.env.P1_ONLY === "2") {
    await routerCases2();
    await extractorCases2();
  } else {
    await routerCases();
    await extractorCases();
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed; ${calls} model calls; $${usd.toFixed(4)} on the dev key`);
  writeFileSync(".e2e/live-check-no-parsing-p1.json", JSON.stringify({ results, calls, usd }, null, 2));
}
void main();
