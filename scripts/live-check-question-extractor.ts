/**
 * LIVE CHECK: the question extractor, each case ONCE (2026-10-20).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Runs the SHIPPED
 * extractor (`extractForRoute`, its prompt and the user turn production
 * builds) on questions from both groups, English and Turkish, and grades the
 * facts. It holds the cases the 2026-10-20 rewrite was made for:
 *
 *   - "Hala yer var mı?" / "Hâlâ boş yer var mı?" (is there still space): a
 *     count, never a kickoff or venue question ("yer" is also "place"). The
 *     quoted call-out names the same match NOW points at, Thursday 20:00.
 *   - "yedek listesi ne?" (the bench's own list): bench, never how_it_works.
 *   - #342's rulings: the list is the squad, and a two-part question gets
 *     the topic whose answer covers both.
 *   - corpus S7: "Should MatchTime put Erdal to the bench or not?" asks about
 *     one named player: person_status, personRef Erdal.
 *
 * and one or more cases for every topic and list field it already reads.
 *
 * ARM=sonnet|haiku runs that model and thinking posture (`arm-model.ts`)
 * instead of the shipped one. PROMPT_FILE=<path> runs that system prompt
 * instead of the shipped one (the before/after arms). OUT=<path> writes
 * every call (latency, tokens, cost) as JSON.
 *
 * ZERO WRITES: no database client is imported.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-question-extractor.ts
 *   ARM=haiku ONLY=K1,K2 node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-question-extractor.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { ARMS, armModel, latency } from "../e2e/helpers/arm-model.ts";
import { EXTRACTOR_CALLS, EXTRACTOR_PROMPTS, extractForRoute } from "../src/lib/pipeline/extractors.ts";
import type { ContextMessage } from "../src/lib/reply-context.ts";
import type { QuestionFacts, QuestionTopic } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("scripts/live-check-question-extractor.ts");

const MAX_USD = 1;
const armName = process.env.ARM;
if (armName && !ARMS[armName]) throw new Error(`ARM must be one of ${Object.keys(ARMS).join(", ")}`);
const arm = armName ? ARMS[armName] : EXTRACTOR_CALLS.question;
if (process.env.PROMPT_FILE) EXTRACTOR_PROMPTS.question = readFileSync(process.env.PROMPT_FILE, "utf8");
const { model, calls, usd } = armModel(arm, MAX_USD);

// Tuesday 20 October 2026, 12:00 London. The match is Thursday 22 at 20:00.
const NOW = new Date("2026-10-20T11:00:00Z");
const CALLOUT_TR = "Perşembe 20:00 maçı için 1 oyuncu daha lazım. Gelebiliyorsanız *VARIM* yazın, yeri kimin alacağını organizatörler onaylayacak.";
const CALLOUT_EN = "We need 1 more player for Thu 20:00. Say *IN* if you can make it and the organisers will confirm who gets the place.";
const quoted = (text: string): ContextMessage => ({ at: new Date("2026-10-20T09:00:00Z"), text, topic: null, match: null, author: null });
const BENCH_POST =
  "*Football 9-a-side* is full at 18 of 18, but the bench is open. Say *IN* to go on the bench, and the organisers will pick who plays. 🙏";

interface Case {
  id: string;
  body: string;
  topic: QuestionTopic | QuestionTopic[];
  reply?: ContextMessage;
  history?: Array<{ author: string | null; body: string }>;
  lastBotPost?: string;
  check?: (f: QuestionFacts) => boolean;
  want?: string;
}

const CASES: Case[] = [
  // The known cases.
  { id: "K1", body: "Hala yer var mı?", topic: "count", reply: quoted(CALLOUT_TR) },
  { id: "K2", body: "Hâlâ boş yer var mı?", topic: "count", reply: quoted(CALLOUT_TR) },
  { id: "K3", body: "@Match Time hala yer var mı", topic: "count" },
  { id: "K4", body: "Is there still space?", topic: "count", reply: quoted(CALLOUT_EN) },
  { id: "K5", body: "@Match Time yer kaldı mı?", topic: "count" },
  { id: "K6", body: "yedek listesi ne?", topic: "bench" },
  { id: "K7", body: "@Match Time yedek listesinde kimler var?", topic: "bench" },
  {
    id: "K8",
    body: "@Match Time Should MatchTime put Erdal to the bench or not?",
    topic: "person_status",
    history: [
      { author: "Erdal Ozkan", body: "consider me as the 14th whenever you have 13 players" },
      { author: "MatchTime", body: "Got it Erdal 👍" },
    ],
    check: (f) => /erdal/i.test(f.personRef ?? ""),
    want: "personRef Erdal",
  },
  // The venue and kickoff stay fixture, in both languages.
  { id: "F1", body: "@Match Time maç nerede?", topic: "fixture" },
  { id: "F2", body: "@Match Time maçın yeri neresi?", topic: "fixture" },
  { id: "F3", body: "@Match Time what time is kickoff?", topic: "fixture" },
  { id: "F4", body: "@Match Time is the game still on?", topic: "fixture" },
  // Squad, count and bench (#342).
  { id: "Q1", body: "@Match Time who's in?", topic: "squad" },
  { id: "Q2", body: "@Match Time liste ne?", topic: "squad" },
  { id: "Q3", body: "Anyone on the bench? Can you show me the list please", topic: "squad" },
  { id: "Q4", body: "Yedek var mı? Listeyi paylaşır mısın", topic: "squad" },
  { id: "Q5", body: "@Match Time what is squad now including bench?", topic: "squad" },
  { id: "Q6", body: "list?", topic: "squad", history: [{ author: "Can", body: "who's on the bench?" }] },
  { id: "C1", body: "@Match Time how many spots left?", topic: "count" },
  { id: "C2", body: "@Match Time kaç kişi eksik?", topic: "count" },
  { id: "C3", body: "@Match Time we're 9/14 right?", topic: "count", check: (f) => f.statedCount === 9, want: "statedCount 9" },
  { id: "C4", body: "@Match Time do we have enough?", topic: "count" },
  { id: "B1", body: "@Match Time who's on the bench?", topic: "bench" },
  { id: "B2", body: "yedekte kimse var mı?", topic: "bench" },
  { id: "B3", body: "what's the bench list?", topic: "bench" },
  { id: "H1", body: "Bench? We do bench now?", topic: "how_it_works", lastBotPost: BENCH_POST, check: (f) => f.feature === "availability", want: "feature availability" },
  { id: "H2", body: "yedek ne demek?", topic: "how_it_works", check: (f) => f.feature === "availability", want: "feature availability" },
  { id: "H3", body: "@Match Time how are the teams picked?", topic: "how_it_works", check: (f) => f.feature === "teams", want: "feature teams" },
  { id: "H4", body: "@Match Time how do I pay?", topic: "how_it_works", check: (f) => f.feature === "payments", want: "feature payments" },
  { id: "H5", body: "@Match Time neler yapabiliyorsun?", topic: "how_it_works" },
  // Help, any wording, every topic (2026-10-28: the regex help reader is
  // gone; the topic is this extractor's `feature`, the badge its `badge`).
  { id: "N1", body: "@Match Time help", topic: "how_it_works", check: (f) => f.feature == null, want: "the menu" },
  { id: "N2", body: "@Match Time yardım", topic: "how_it_works", check: (f) => f.feature == null, want: "the menu" },
  { id: "N3", body: "help", topic: "how_it_works", check: (f) => f.feature == null, want: "the menu (a DM)" },
  { id: "N4", body: "@Match Time what can you do", topic: "how_it_works", check: (f) => f.feature == null, want: "the menu" },
  { id: "N5", body: "@Match Time how do I turn on the player pool?", topic: "how_it_works", check: (f) => f.feature === "pool", want: "feature pool" },
  { id: "N6", body: "havuz nasıl açılır", topic: "how_it_works", check: (f) => f.feature === "pool", want: "feature pool" },
  { id: "N7", body: "how can I play for other teams near me too?", topic: "how_it_works", check: (f) => f.feature === "pool", want: "feature pool (a DM)" },
  { id: "N8", body: "@Match Time how do partner clubs work?", topic: "how_it_works", check: (f) => f.feature === "partners", want: "feature partners" },
  { id: "N9", body: "@Match Time başka kulüplerle nasıl eşleşiriz?", topic: "how_it_works", check: (f) => f.feature === "partners", want: "feature partners" },
  { id: "N10", body: "@Match Time where do I find the settings?", topic: "how_it_works", check: (f) => f.feature === "settings", want: "feature settings" },
  { id: "N11", body: "ayarları nereden değiştiriyorum", topic: "how_it_works", check: (f) => f.feature === "settings", want: "feature settings (a DM)" },
  { id: "N12", body: "@Match Time help badges Mr Reliable", topic: "how_it_works", check: (f) => f.feature === "badges" && f.badge === "reliable", want: "badges, reliable" },
  { id: "N13", body: "@Match Time how do I get the Iron Man badge?", topic: "how_it_works", check: (f) => f.feature === "badges" && f.badge === "ironman", want: "badges, ironman" },
  { id: "N14", body: "@Match Time yardım rozetler", topic: "how_it_works", check: (f) => f.feature === "badges" && f.badge == null, want: "badges, every badge" },
  { id: "N15", body: "@Match Time how do I change the kick-off time for the season?", topic: "how_it_works", check: (f) => f.feature === "schedule", want: "feature schedule" },
  { id: "N16", body: "@Match Time can we switch off man of the match?", topic: "how_it_works", check: (f) => f.feature === "mom", want: "feature mom" },
  { id: "N17", body: "@Match Time help ratings", topic: "how_it_works", check: (f) => f.feature === "ratings", want: "feature ratings" },
  { id: "N18", body: "@Match Time yardım ödeme", topic: "how_it_works", check: (f) => f.feature === "payments", want: "feature payments" },
  { id: "N19", body: "@Match Time how do I turn the reminders off?", topic: "how_it_works", check: (f) => f.feature === "reminders", want: "feature reminders" },
  // The rest of the topics.
  { id: "P1", body: "@Match Time Zair geliyor mu?", topic: "person_status", check: (f) => /zair/i.test(f.personRef ?? ""), want: "personRef Zair" },
  { id: "P2", body: "@Match Time anyone in the squad without a number?", topic: "phones" },
  { id: "O1", body: "@Match Time eksiğiz, ne yapabiliriz?", topic: "options" },
  { id: "L1", body: "@Match Time who runs this group?", topic: "club" },
  { id: "L2", body: "@Match Time ücreti kime ödüyoruz?", topic: "club" },
  { id: "L3", body: "@Match Time when will the teams be out?", topic: "club" },
  { id: "M1", body: "@Match Time kim ödemedi?", topic: "payments" },
  { id: "M2", body: "@Match Time has everyone paid for last week?", topic: "payments" },
  { id: "R1", body: "@Match Time who hasn't rated yet?", topic: "rating_progress" },
  { id: "R2", body: "please do not forget to rate the players via the link from Matchtime DM'ed to you", topic: "other" },
  { id: "S1", body: "@Match Time salı kim kazandı?", topic: "score" },
  { id: "S2", body: "@Match Time give us the scores of the last 5 matches", topic: "score", check: (f) => f.listSize === 5, want: "listSize 5" },
  { id: "S3", body: "@Match Time what was the score last week", topic: "score", check: (f) => f.listSize == null && f.period == null, want: "one match: no list, no period" },
  { id: "S4", body: "@Match Time bu sezonun sonuçları", topic: "score", check: (f) => f.period?.kind === "season", want: "period season" },
  { id: "Y1", body: "@Match Time istatistiklerim", topic: "my_stats" },
  { id: "Y2", body: "@Match Time how am I doing this season?", topic: "my_stats" },
  { id: "T1", body: "@Match Time please share the leaderboard of ratings, top 10", topic: "stats", check: (f) => f.table === "ratings" && f.listSize === 10, want: "ratings, 10" },
  { id: "T2", body: "@Match Time bottom 5 on elo", topic: "stats", check: (f) => f.table === "elo" && f.listSize === 5 && f.listEnd === "bottom", want: "elo, 5, bottom" },
  { id: "T3", body: "@Match Time son 1 yılda en çok maç oynayan kim?", topic: "stats", check: (f) => f.table === "appearances" && f.period?.kind === "last" && f.period.count === 1 && f.period.unit === "year", want: "appearances, last 1 year" },
  { id: "T4", body: "@Match Time who's my nemesis", topic: "stats", check: (f) => f.table === "chemistry" && f.personRef === "me", want: "chemistry, me" },
  { id: "T5", body: "@Match Time who is the most Mr. Reliable?", topic: "stats", check: (f) => f.table === "mr_reliable", want: "mr_reliable" },
  { id: "T6", body: "@Match Time who has the best win rate", topic: "stats", check: (f) => f.table === "other", want: "other" },
  { id: "T7", body: "@Match Time bu ay en çok kim oynadı", topic: "stats", check: (f) => f.table === "appearances" && f.period?.kind === "this" && f.period.unit === "month", want: "appearances, this month" },
  { id: "T8", body: "@Match Time tüm zamanların en çok maçın adamı kim", topic: "stats", check: (f) => f.table === "mom" && f.period?.kind === "all_time", want: "mom, all time" },
  { id: "T9", body: "@Match Time what are Wasim's stats", topic: "stats", check: (f) => /wasim/i.test(f.personRef ?? ""), want: "personRef Wasim" },
  { id: "T10", body: "@Match Time whose performance is improving most based on the last 3 matches?", topic: "stats", check: (f) => f.table === "movers", want: "movers" },
];

async function main() {
  const only = process.env.ONLY?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  const results: Array<{ id: string; body: string; pass: boolean; got: unknown }> = [];
  for (const c of cases) {
    const ex = await extractForRoute(model, "question", {
      id: c.id,
      body: c.body,
      authorName: "Can",
      tagged: c.body.includes("@Match Time"),
      history: c.history ?? [],
      lastBotPost: c.lastBotPost ?? null,
      reply: c.reply ?? null,
      now: NOW,
    });
    const f = ex.facts.kind === "question" ? ex.facts : null;
    const topics = Array.isArray(c.topic) ? c.topic : [c.topic];
    const pass = !!f && topics.includes(f.topic) && (!c.check || c.check(f));
    const got = f && { topic: f.topic, feature: f.feature, badge: f.badge, personRef: f.personRef, statedCount: f.statedCount, table: f.table, listSize: f.listSize, listEnd: f.listEnd, period: f.period };
    results.push({ id: c.id, body: c.body, pass, got: got ?? ex.degradations.map((d) => d.detail) });
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.id}  ${JSON.stringify(c.body)}  ${JSON.stringify(got)}  (want ${topics.join("|")}${c.want ? `, ${c.want}` : ""})`);
  }
  const passed = results.filter((r) => r.pass).length;
  const lat = latency(calls);
  const empty = calls.filter((c) => c.empty).length;
  const maxOut = Math.max(0, ...calls.map((c) => c.outputTokens));
  console.log(
    `\n${passed}/${results.length} passed on ${arm.model}${process.env.PROMPT_FILE ? ` with ${process.env.PROMPT_FILE}` : ""}. ` +
      `Calls ${calls.length}, cost $${usd().toFixed(5)} ($${(usd() / Math.max(1, calls.length)).toFixed(6)}/call), ` +
      `p50 ${lat.p50} ms, p90 ${lat.p90} ms, empty ${empty}, max output ${maxOut} tokens (dev key).`,
  );
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ model: arm.model, results, calls, p50: lat.p50, p90: lat.p90, usd: usd() }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

void main();
