/**
 * THE GENERIC STATS ANSWER: THE PAID CHECK (2026-10-20).
 *
 * Drives the shipped `answerGenericStats` (the real prompt, the real
 * context builder, the real grounding check) against the real model, on
 * fixture tables. No database. EN and TR questions, ones the tables
 * answer and ones they cannot ("worst", goals, sums), plus a
 * contradictory one to show whether Haiku 5.5's thinking ever eats the
 * whole budget and returns nothing.
 *
 *   ARM=sonnet|haiku TAG=new OUT=/path/result.json \
 *     DATABASE_URL=postgresql://none@127.0.0.1:1/none \
 *     node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-stats-generic.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Each case once.
 */
import fs from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { ARMS, armModel, latency } from "../e2e/helpers/arm-model.ts";
import { answerGenericStats } from "../src/lib/pipeline/stats-generic.ts";
import type { Member, StatsSnapshot } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("the generic stats live check");
const ARM = process.env.ARM ?? "sonnet";
const TAG = process.env.TAG ?? "new";
const arm = ARMS[ARM];
if (!arm) throw new Error(`ARM must be one of ${Object.keys(ARMS).join(", ")}`);
const { model, calls, usd } = armModel(arm, 1);

const P = (userId: string, name: string) => ({ userId, name });
const ali = P("u-ali", "Ali Kaya");
const dan = P("u-dan", "Dan Moore");
const emre = P("u-emre", "Emre Şahin");
const sam = P("u-sam", "Sam Price");
const joe = P("u-joe", "Joe Hart");
const can = P("u-can", "Can Yıldız");

const SNAPSHOT: StatsSnapshot = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [
    { ...ali, avg: 8.2, games: 11, rank: 1, delta: 0 },
    { ...dan, avg: 7.9, games: 9, rank: 2, delta: 2 },
    { ...emre, avg: 7.4, games: 12, rank: 3, delta: -1 },
    { ...sam, avg: 7.1, games: 6, rank: 4, delta: null },
  ],
  mom: [
    { ...dan, wins: 4 },
    { ...ali, wins: 3 },
  ],
  elo: [
    { ...emre, rating: 1612, matches: 14 },
    { ...ali, rating: 1580, matches: 12 },
  ],
  teamOfSeason: {
    sportName: "Football",
    slots: [
      { ...joe, position: "GK", avg: 7.3, games: 8 },
      { ...emre, position: "DEF", avg: 7.4, games: 12 },
      { ...ali, position: "MID", avg: 8.2, games: 11 },
      { ...dan, position: "FWD", avg: 7.9, games: 9 },
    ],
  },
  mrReliable: [{ ...emre, avg: 7.4, games: 12, spread: 0.4 }],
  aliases: [],
  chemistry: {
    "u-sam": {
      userId: "u-sam",
      name: "Sam Price",
      bestByWinRate: { name: "Dan Moore", gamesTogether: 5, wins: 4, winRate: 0.8 },
      bestByRating: { name: "Ali Kaya", myAvgWith: 7.6, sameAsWinRate: false },
      nemesis: { name: "Emre Şahin", gamesAgainst: 4, wins: 1 },
    },
  },
  appearances: [
    { ...emre, matches: 16 },
    { ...ali, matches: 14 },
    { ...can, matches: 13 },
  ],
  recordsStart: { matches: new Date("2026-04-07T19:00:00.000Z"), mom: new Date("2026-04-07T19:00:00.000Z") },
  periods: {},
  generic: {},
};

const ROSTER: Member[] = [ali, dan, emre, sam, joe, can, P("u-tom", "Tom Reed"), P("u-mert", "Mert Aksoy")].map((p) => ({
  ...p,
  isAdmin: false,
  hasPhone: true,
}));

type Want =
  /** A grounded answer naming one of these. */
  | { answer: string[] }
  /** The tables cannot answer it: NO_ANSWER, or a grounded reply that names nobody it must not. */
  | { none: true; mustNot?: RegExp };

interface Case {
  q: string;
  lang: "en" | "tr";
  want: Want;
  person?: string;
  self?: boolean;
  why: string;
}

const WORST = /\b(worst|lowest|bottom)\b|en kötü|en düşük|sonuncu/i;
const CASES: Case[] = [
  { q: "who has the most man of the match awards?", lang: "en", want: { answer: ["Dan Moore"] }, why: "MoM top" },
  { q: "who's played the most games since we started?", lang: "en", want: { answer: ["Emre"] }, why: "appearances top" },
  { q: "what's Ali's rating at the moment?", lang: "en", want: { answer: ["8.2"] }, person: "u-ali", why: "named player" },
  { q: "who's my best teammate?", lang: "en", want: { answer: ["Dan"] }, person: "u-sam", self: true, why: "self chemistry" },
  { q: "who made the team of the season in goal?", lang: "en", want: { answer: ["Joe"] }, why: "team of season slot" },
  { q: "who has the Mr Reliable badge?", lang: "en", want: { answer: ["Emre"] }, why: "badge" },
  { q: "who's top of the elo?", lang: "en", want: { answer: ["Emre"] }, why: "elo top" },
  { q: "who's climbed the ratings since the last game?", lang: "en", want: { answer: ["Dan"] }, why: "delta up" },
  { q: "who is the worst player in the club?", lang: "en", want: { none: true, mustNot: WORST }, why: "bottom never said" },
  { q: "who scored the most goals this season?", lang: "en", want: { none: true }, why: "no goals table" },
  { q: "what's the average rating of the whole club?", lang: "en", want: { none: true }, why: "would need a new number" },
  { q: "how much higher is Ali's rating than Dan's, as a percentage?", lang: "en", want: { none: true }, why: "a computed difference" },
  {
    q: "who's the best and the worst, and is the best one actually better than the worst or not, explain both ways?",
    lang: "en",
    want: { none: true, mustNot: WORST },
    why: "contradictory: the T5-style runaway probe",
  },
  { q: "en çok maçın adamı seçilen kim?", lang: "tr", want: { answer: ["Dan Moore"] }, why: "TR MoM top" },
  { q: "en çok maça kim çıktı?", lang: "tr", want: { answer: ["Emre"] }, why: "TR appearances" },
  { q: "Ali'nin puanı kaç?", lang: "tr", want: { answer: ["8,2", "8.2"] }, person: "u-ali", why: "TR named player" },
  { q: "sezonun takımında kimler var?", lang: "tr", want: { answer: ["Joe", "Ali"] }, why: "TR team of season" },
  { q: "en kötü oyuncu kim?", lang: "tr", want: { none: true, mustNot: WORST }, why: "TR bottom never said" },
  { q: "bu sezon en çok gol atan kim?", lang: "tr", want: { none: true }, why: "TR no goals table" },
];

/** An English reply in a Turkish group, roughly: two common English words. */
const ENGLISH = /\b(the|with|has|is|from)\b/i;

/** A first name followed by a surname that is not that player's own
 *  (the corruption "Emre \"ahin" seen once on the baseline). */
function misspeltName(text: string): string | null {
  for (const m of ROSTER) {
    const [first, ...rest] = m.name.split(" ");
    const surname = rest.join(" ");
    const re = new RegExp(`${first} (\\S+)`, "gu");
    for (const hit of text.matchAll(re)) {
      const next = hit[1];
      if (/^\p{Lu}|^["'“”]/u.test(next) && !surname.startsWith(next.replace(/[^\p{L}]+$/u, "").replace(/['’]\p{L}*$/u, ""))) return `${first} ${next}`;
    }
  }
  return null;
}

/** PURE. Pass or fail one case from what the shipped function returned. */
function judge(c: Case, text: string | null, rejected: string | null): { ok: boolean; note: string } {
  if (text) {
    const bad = misspeltName(text);
    if (bad) return { ok: false, note: `misspelt name "${bad}"` };
  }
  if ("answer" in c.want) {
    const ok = !!text && c.want.answer.some((x) => text.includes(x));
    if (ok && c.lang === "tr" && ENGLISH.test(text)) return { ok: false, note: "English in a Turkish group" };
    return { ok, note: "" };
  }
  if (rejected) return { ok: /do not answer/.test(rejected), note: "" };
  // A grounded reply is fine unless a sentence calls a named player the worst.
  const mustNot = c.want.mustNot;
  const callsSomeoneWorst =
    !!mustNot &&
    (text ?? "").split(/[.!?\n]/).some((s) => mustNot.test(s) && ROSTER.some((m) => s.includes(m.name)));
  return { ok: !callsSomeoneWorst, note: callsSomeoneWorst ? "calls a named player the worst" : "" };
}

async function main() {
  if (process.env.RESCORE) return rescore(process.env.RESCORE);
  const rows: Array<Record<string, unknown>> = [];
  let pass = 0;
  for (const c of CASES.slice(0, Number(process.env.LIMIT ?? CASES.length))) {
    const before = calls.length;
    const g = await answerGenericStats({
      model,
      snapshot: SNAPSHOT,
      lang: c.lang,
      question: c.q,
      personUserId: c.person ?? null,
      self: c.self ?? false,
      roster: ROSTER,
    });
    const call = calls[before];
    const text = "text" in g.result ? g.result.text : null;
    const rejected = "rejected" in g.result ? g.result.rejected : null;
    const j = judge(c, text, rejected);
    const ok = j.ok;
    let note = j.note;
    if (call?.empty) note = (note ? note + "; " : "") + `EMPTY (${call.stopReason ?? call.error})`;
    if (ok) pass++;
    rows.push({ q: c.q, lang: c.lang, why: c.why, ok, text, rejected, raw: call?.raw, note, ms: call?.ms, usd: call?.usd, in: call?.inputTokens, out: call?.outputTokens });
    console.log(`${ok ? "PASS" : "FAIL"}  [${c.lang}] ${c.q}\n      -> ${text ?? `rejected: ${rejected}`}${note ? `  (${note})` : ""}  ${call?.ms}ms out=${call?.outputTokens}`);
  }
  const lat = latency(calls);
  const summary = {
    name: "stats-generic",
    arm: ARM,
    model: arm.model,
    prompt: TAG,
    result: `${pass}/${rows.length}`,
    calls: calls.length,
    cost: Number(usd().toFixed(6)),
    costPerCall: Number((usd() / Math.max(1, calls.length)).toFixed(6)),
    p50ms: lat.p50,
    p90ms: lat.p90,
    empty: calls.filter((c) => c.empty).length,
    rows,
  };
  console.log(`\n${summary.result} on ${arm.model} (${TAG} prompt), ${calls.length} calls, $${summary.cost}, p50 ${lat.p50}ms p90 ${lat.p90}ms, empty ${summary.empty}`);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(summary, null, 2));
}

/** Re-judge a saved run with the current `judge` (no model calls). */
function rescore(file: string) {
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  let pass = 0;
  for (const r of run.rows) {
    const c = CASES.find((x) => x.q === r.q);
    if (!c) continue;
    Object.assign(r, judge(c, r.text, r.rejected));
    if (r.ok) pass++;
    else console.log(`FAIL [${r.lang}] ${r.q} -> ${r.text ?? r.rejected} (${r.note})`);
  }
  run.result = `${pass}/${run.rows.length}`;
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  console.log(`${file}: ${run.result}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
