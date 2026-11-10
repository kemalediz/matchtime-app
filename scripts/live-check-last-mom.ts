/**
 * THE LAST MAN OF THE MATCH: THE PAID END-TO-END CHECK (2026-11-10).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only, each case
 *     once, hard cap MAX_USD.
 *
 * Sutton FC, Tue 10 Nov 19:25: "@Match Time who was the last MoM and for
 * which game it was? How many votes did he get out of how many votes?" was
 * answered with the all-time Man of the Match top 10. This drives the REAL
 * path for that message and its variants, once each, against a seeded club
 * (no database, nothing sent): the router, then `runAnswerBatch` (the real
 * question extractor, who-is-who, and the grounded generic stats answer
 * given the club's stats context, `last-mom.ts` included).
 *
 * The seeded last Man of the Match is Sutton FC's real one, read read-only
 * from production on 2026-11-10: Tue 20 Oct, Red 7 Yellow 9, shared between
 * Habib and Mojib on 2 votes each of 7 (Burak Yildiz, Ozgur, Sait 1 each).
 * One case swaps in an organisers' pick, one a club with no Man of the
 * Match yet.
 *
 * Prints, per case: route, topic and table, intent, the reply verbatim, and
 * what a good answer must do. Judged by reading.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-last-mom.ts
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). WHAT ONE PASS
 * CANNOT PROVE: an occasional miss can pass once and fail live.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { routeBatch } from "../src/lib/pipeline/router.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import type { LastMomFacts } from "../src/lib/pipeline/last-mom.ts";
import type { OrgFeatures } from "../src/lib/org-features.ts";
import type { Member, Route, SquadState, StatsSnapshot } from "../src/lib/pipeline/types.ts";

const MAX_USD = 0.4;
spendDevApiKeyOrExit("the last Man of the Match live check");

let calls = 0;
let usd = 0;
const byLabel = new Map<string, { calls: number; usd: number }>();
const facts: string[] = [];
let lastGenericRaw: string | null = null;
const inner = anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD) throw new Error(`stopped at $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    if (req.label.startsWith("extract")) facts.push(r.text);
    if (req.label === "stats-generic") lastGenericRaw = r.text;
    const l = byLabel.get(req.label) ?? { calls: 0, usd: 0 };
    byLabel.set(req.label, { calls: l.calls + 1, usd: l.usd + (r.costUsd ?? 0) });
    return r;
  },
};

const NAMES = ["Kemal Ediz", "Mojib", "Habib", "Burak Yildiz", "Ozgur", "Sait", "Mustafa Cayir", "Idris", "Wasim", "Najib", "Zeeshan", "Abid"];
const id = (n: string) => `u-${n.toLowerCase().replace(/\W+/g, "-")}`;
const roster: Member[] = NAMES.map((n, i) => ({ userId: id(n), name: n, isAdmin: i === 0, hasPhone: true }));
const v = (n: string, votes: number) => ({ userId: id(n), name: n, votes });

const SUTTON_LAST: LastMomFacts = {
  last: {
    date: new Date("2026-10-20T19:30:00.000Z"),
    teamLabels: ["Red", "Yellow"],
    score: { red: 7, yellow: 9 },
    winners: [v("Habib", 2), v("Mojib", 2)],
    tally: [v("Habib", 2), v("Mojib", 2), v("Burak Yildiz", 1), v("Ozgur", 1), v("Sait", 1)],
    totalVotes: 7,
    pickedByOrganisers: false,
  },
  openVoteDate: null,
};
const PICKED: LastMomFacts = {
  last: {
    date: new Date("2026-11-03T21:30:00.000Z"),
    teamLabels: ["Kırmızı", "Sarı"],
    score: { red: 5, yellow: 4 },
    winners: [v("Mojib", 1)],
    tally: [v("Mojib", 1)],
    totalVotes: 1,
    pickedByOrganisers: true,
  },
  openVoteDate: null,
};

function tables(lastMom: LastMomFacts): Omit<StatsSnapshot, "chemistry" | "generic" | "periods"> {
  return {
    fullTableUrl: "https://matchtime.ai/profile/stats",
    ratings: [
      { userId: id("Mojib"), name: "Mojib", avg: 7.8, games: 14, rank: 1, delta: 0 },
      { userId: id("Habib"), name: "Habib", avg: 7.5, games: 12, rank: 2, delta: 1 },
    ],
    mom: [
      { userId: id("Mojib"), name: "Mojib", wins: 6 },
      { userId: id("Habib"), name: "Habib", wins: 4 },
      { userId: id("Sait"), name: "Sait", wins: 3 },
      { userId: id("Wasim"), name: "Wasim", wins: 2 },
      { userId: id("Idris"), name: "Idris", wins: 2 },
      { userId: id("Abid"), name: "Abid", wins: 1 },
    ],
    elo: [],
    teamOfSeason: null,
    mrReliable: [],
    aliases: [],
    appearances: [],
    recordsStart: { matches: new Date("2026-04-14T19:30:00.000Z"), mom: new Date("2026-04-14T19:30:00.000Z") },
    completedMatches: 24,
    lastMom,
  };
}

function state(lang: "en" | "tr"): SquadState {
  return {
    matchId: "m-tue",
    maxPlayers: 14,
    kickoffLabel: "Tue 10 Nov, 21:30",
    matchLabel: "Tue 10 Nov, 21:30",
    venue: "Goals Sutton",
    rows: [],
    roster,
    openOffers: [],
    teams: [],
    teamLabels: lang === "tr" ? ["Kırmızı", "Sarı"] : ["Red", "Yellow"],
    completedMatch: null,
    lastBotPost: null,
    features: {
      attendance: true,
      paymentTracking: false,
      statsQa: true,
      reminders: true,
      language: lang,
      benchPickMode: "first-come",
      listAnnouncer: "matchtime",
    },
    smallerFormats: [],
    guestAskedUserIds: [],
    payments: null,
    ratingProgress: null,
  } as unknown as SquadState;
}

const FEATURES = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
} as OrgFeatures;

interface Case {
  text: string;
  lang: "en" | "tr";
  lastMom: LastMomFacts;
  good: string;
}
const CASES: Case[] = [
  { text: "@Match Time who was the last MoM and for which game it was? How many votes did he get out of how many votes?", lang: "en", lastMom: SUTTON_LAST, good: "Tue 20 Oct (Yellow 9-7), shared Habib and Mojib, 2 votes each of 7" },
  { text: "@Match Time who won MoM last week?", lang: "en", lastMom: SUTTON_LAST, good: "the last one is 20 Oct, shared Habib and Mojib (honest that it was not last week)" },
  { text: "@Match Time how many votes did Mojib get?", lang: "en", lastMom: SUTTON_LAST, good: "2 of 7 in the last vote (20 Oct), or his 6 wins; nothing invented" },
  { text: "@Match Time who came second in the last MoM vote?", lang: "en", lastMom: SUTTON_LAST, good: "a tie at the top (Habib, Mojib 2 each), then Burak Yildiz, Ozgur, Sait 1 each" },
  { text: "@Match Time geçen haftanın maçın adamı kim?", lang: "tr", lastMom: SUTTON_LAST, good: "Turkish: 20 Ekim, Habib ve Mojib paylaştı, 2'şer oy (7 oydan)" },
  { text: "@Match Time son maçta maçın adamı kaç oyla seçildi?", lang: "tr", lastMom: SUTTON_LAST, good: "Turkish: 2 oy, 7 oydan, Habib ve Mojib" },
  { text: "@Match Time who has the most MoM?", lang: "en", lastMom: SUTTON_LAST, good: "the ranking table (code), Mojib 6 first" },
  { text: "@Match Time top 5 MoM", lang: "en", lastMom: SUTTON_LAST, good: "the ranking table, 5 rows" },
  { text: "@Match Time son maçın adamı kimdi?", lang: "tr", lastMom: PICKED, good: "Turkish: Mojib, picked by the organisers, no vote count" },
  { text: "@Match Time who was the last man of the match?", lang: "en", lastMom: { last: null, openVoteDate: null }, good: "none decided yet; no name invented" },
];

async function main() {
  const NOW = new Date("2026-11-10T19:25:00.000Z");
  const only = process.env.ONLY?.split(",").map(Number);
  for (const [i, c] of CASES.entries()) {
    if (only && !only.includes(i + 1)) continue;
    const st = state(c.lang);
    const before = calls;
    const beforeUsd = usd;
    facts.length = 0;
    lastGenericRaw = null;
    console.log(`\n── ${i + 1}. [${c.lang}] ${JSON.stringify(c.text)}`);
    console.log(`   good: ${c.good}`);
    const r = await routeBatch(model, [{ id: `p${i}`, authorName: "Kemal Ediz", body: c.text }], { floor: false, awaiting: null });
    const route = r.routes[0]?.route as Route | undefined;
    console.log(`   route: ${route}`);
    const res = await runAnswerBatch({
      orgId: "org-x",
      now: NOW,
      messages: [
        {
          waMessageId: `p-${i}`,
          body: c.text,
          authorName: "Kemal Ediz",
          senderUserId: id("Kemal Ediz"),
          senderName: "Kemal Ediz",
          tagged: true,
          addressed: true,
          route,
          gated: false,
        },
      ],
      history: [{ author: "Kemal Ediz", body: c.text }],
      expectedMatchId: st.matchId,
      enabled: new Set<Route>(["question", "balancer"]),
      deps: {
        model,
        loadState: async () => st,
        loadFeatures: async () => ({ ...FEATURES, language: c.lang }) as OrgFeatures,
        loadStats: async () => tables(c.lastMom),
        // The seeded club has no chemistry; the real read needs a database.
        loadChemistry: async () => null,
      },
    });
    for (const f of facts) console.log(`   facts: ${f.replace(/\s+/g, " ").slice(0, 300)}`);
    const o = res.outcomes.get(`p-${i}`);
    console.log(`   intent: ${o?.intent ?? "(unowned)"}`);
    if (res.degradations.length) console.log(`   degradations: ${res.degradations.join(" | ").slice(0, 400)}`);
    if (lastGenericRaw) console.log(`   generic raw: ${lastGenericRaw.replace(/\s+/g, " ").slice(0, 300)}`);
    console.log(`   reply:\n${(o?.reply ?? "(none)").split("\n").map((l) => `     | ${l}`).join("\n")}`);
    console.log(`   calls: ${calls - before}, $${(usd - beforeUsd).toFixed(5)}`);
  }
  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  for (const [label, x] of byLabel) console.log(`  ${label}: ${x.calls} call(s), $${x.usd.toFixed(5)}`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\nModel calls: ${calls}. Cost: $${usd.toFixed(4)} (dev key).`);
  process.exit(1);
});
