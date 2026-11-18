/**
 * THE UNIFIED ANSWER AFTER THE CLEANUP: THE PAID CHECK (2026-11-18).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only, each case
 *     once, hard cap MAX_USD (default $0.50). Run only with Kemal's yes.
 *
 * The four things the cleanup PR changed in what the unified answer is
 * shown, each through the REAL path (`runAnswerBatch`, the real question
 * extractor where the path has one, the real help menus, the real grounding
 * check), against a made-up club (no database, nothing sent):
 *
 *   A. Sutton 17 Nov 19:23, a dead end told WHY: admin "swap Sam with Alex",
 *      neither a player of the match (`swapNotDoneWhy`). ONE call a case.
 *   B. Sutton 17 Nov 12:53, a question beside a change ALREADY DONE: "switch
 *      the match to 7aside and tell us the current list", the switch's reply
 *      shown to the answer (`alsoDone`). TWO calls (extractor, answer).
 *   C. FNF HQ "I meant the registered players, not asking the teams yet",
 *      after a ratings exchange in HQ's chat: the registered count, never
 *      the ratings again. TWO calls.
 *   D. A bench question in the words "waiting list": the reply says "the
 *      bench" ("yedek"), never "waiting list". TWO calls.
 *
 * Each in English and Turkish: 14 model calls, about $0.01 (the unified
 * answer measured $0.00111 a question with its extractor, PR #595).
 *
 *   node --env-file=/path/to/repo/.env ./node_modules/.bin/tsx scripts/live-check-unified-cleanup.ts
 *
 * DRY=1: a stub model, $0, to check the wiring (SHOW_TURN=1 prints each
 * turn). ONLY=1,3: those cases. Prints, per case, the reply verbatim (or why
 * it was refused) and what a good reply does. Judged by reading. WHAT ONE
 * PASS CANNOT PROVE: an occasional miss can pass once and fail live.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { clubHelpReply } from "../src/lib/help-answer.ts";
import { buildHqHelp } from "../src/lib/admin-group-help.ts";
import { helpFeaturesFrom } from "../src/lib/onboarding-conversation.ts";
import { swapNotDoneWhy } from "../src/lib/team-slot-swap.ts";
import type { OrgFeatures } from "../src/lib/org-features.ts";
import type { HelpClubFacts } from "../src/lib/help-club-facts.ts";
import type { ClubSnapshot, Member, Route, SquadState, StatsSnapshot } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
const DRY = process.env.DRY === "1";
if (!DRY) spendDevApiKeyOrExit("the unified cleanup live check");

let calls = 0;
let usd = 0;
const inner: PipelineModel = DRY
  ? {
      name: "dry",
      async complete(req) {
        if (process.env.SHOW_TURN === "1") console.log(`--- ${req.label}\n${req.user}`);
        const text = req.label === "unified-answer" ? JSON.stringify({ answer: "Dry run." }) : JSON.stringify({ kind: "other", personRef: "", feature: "none", badge: "none" });
        return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
      },
    }
  : anthropicModel();
const model: PipelineModel = {
  name: "metered",
  async complete(req) {
    if (usd >= MAX_USD * 0.9) throw new Error(`stopped before $${MAX_USD}`);
    const r = await inner.complete(req);
    calls++;
    usd += r.costUsd ?? 0;
    const u = r.usage;
    console.log(`   [${req.label}] ${u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)} input tokens, ${u.outputTokens} output, $${(r.costUsd ?? 0).toFixed(5)}`);
    if (req.label === "extractor:question") console.log(`   extractor said: ${r.text}`);
    return r;
  },
};

// ── A made-up club: 7 a side, MatchTime posts the list ──────────────────
const NAMES = ["Ava Stone", "Ben Hale", "Cem Aksoy", "Deniz Uçar", "Eli Brook", "Finn Marsh", "Gus Reed", "Hal Pike", "Ivo Lane", "Jem Cole", "Kit Vale", "Lev Ash", "Max Penn", "Ned Rowe", "Oz Kerr"];
const id = (n: string) => `u-${n.toLowerCase().replace(/\W+/g, "-")}`;
const roster: Member[] = NAMES.map((n, i) => ({ userId: id(n), name: n, isAdmin: i < 2, hasPhone: true }));
const SQUAD = NAMES.slice(0, 11);
const BENCH = ["Max Penn", "Ned Rowe"];

function state(lang: "en" | "tr"): SquadState {
  let pos = 0;
  return {
    matchId: "m-tue",
    maxPlayers: 14,
    kickoffLabel: lang === "tr" ? "Sal 17 Kas, 21:30" : "Tue 17 Nov, 21:30",
    matchLabel: lang === "tr" ? "Sal 17 Kas, 21:30" : "Tue 17 Nov, 21:30",
    venue: "Riverside Arena",
    rows: [
      ...SQUAD.map((n) => ({ userId: id(n), status: "CONFIRMED" as const, position: ++pos })),
      ...BENCH.map((n) => ({ userId: id(n), status: "BENCH" as const, position: ++pos })),
    ],
    roster,
    openOffers: [],
    teams: [],
    teamLabels: ["Bibs", "Non Bibs"],
    completedMatch: {
      id: "m-last",
      kickoffLabel: lang === "tr" ? "Sal 10 Kas, 21:30" : "Tue 10 Nov, 21:30",
      status: "COMPLETED",
      isHistorical: false,
      redScore: 7,
      yellowScore: 5,
      participantUserIds: [],
    },
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: true, reminders: true, language: lang, benchPickMode: "first_come", listAnnouncer: "matchtime" },
    smallerFormats: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    guestAskedUserIds: [],
    payments: null,
    ratingProgress: null,
  } as SquadState;
}

const CLUB: ClubSnapshot = { collectorName: "Ben Hale", feePerPlayer: 6, feeSplitTotal: false, teamsReady: "18:00" };
const CLUB_FACTS: HelpClubFacts = { pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 2 } };
const TABLES: Omit<StatsSnapshot, "chemistry" | "generic" | "periods"> = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [
    { userId: id("Cem Aksoy"), name: "Cem Aksoy", avg: 7.4, games: 6, rank: 1, delta: 0 },
    { userId: id("Ava Stone"), name: "Ava Stone", avg: 7.1, games: 8, rank: 2, delta: 0 },
  ],
  mom: [{ userId: id("Eli Brook"), name: "Eli Brook", wins: 2 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  appearances: [{ userId: id("Ava Stone"), name: "Ava Stone", matches: 8 }, { userId: id("Cem Aksoy"), name: "Cem Aksoy", matches: 7 }],
  recordsStart: { matches: new Date("2026-09-04T19:30:00.000Z"), mom: new Date("2026-09-04T19:30:00.000Z") },
  completedMatches: 10,
};
const LAST_RATINGS = { date: new Date("2026-11-10T21:30:00.000Z"), rows: [{ userId: id("Cem Aksoy"), name: "Cem Aksoy", avg: 7.8, count: 9 }, { userId: id("Ava Stone"), name: "Ava Stone", avg: 7.2, count: 8 }] };
const features = (lang: "en" | "tr") =>
  ({
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
    language: lang,
    squadMode: "weekly",
    benchPickMode: "first_come",
  }) as unknown as OrgFeatures;

const at = (iso: string) => new Date(iso);
/** HQ's chat before the correction: an organiser asked for last week's
 *  ratings, and MatchTime gave them (the FNF A/B's shape). */
const HQ_CHAT = (lang: "en" | "tr") => [
  { author: "Ava Stone", body: lang === "tr" ? "@Match Time geçen haftanın puanları neydi?" : "@Match Time what were last week's ratings?", at: at("2026-11-17T09:00:00.000Z") },
  { author: "MatchTime", body: lang === "tr" ? "10 Kasım: Cem Aksoy 7,8, Ava Stone 7,2." : "Tue 10 Nov: Cem Aksoy 7.8, Ava Stone 7.2.", at: at("2026-11-17T09:00:30.000Z") },
  { author: "Ava Stone", body: lang === "tr" ? "@Match Time kaç oyuncumuz var?" : "@Match Time how many players do we have?", at: at("2026-11-17T09:05:00.000Z") },
  { author: "MatchTime", body: lang === "tr" ? "Teams henüz yapılmadı." : "The teams aren't made yet.", at: at("2026-11-17T09:05:30.000Z") },
];

const SWITCHED = (lang: "en" | "tr") =>
  lang === "tr" ? "🔁 *Maç değişti*: artık *Football 7-a-side* (14 oyuncu)." : "🔁 *Match switched*: now *Football 7-a-side* (14 players).";

interface Case {
  item: "A" | "B" | "C" | "D";
  where: "players" | "organisers";
  lang: "en" | "tr";
  asker: string;
  body: string;
  /** A: a dead end, with why its path stopped. */
  why?: string;
  /** B: the message also asked; what the other part already did. */
  alsoDone?: string;
  good: string;
}
const ADMIN = "Ava Stone";
const MEMBER = "Gus Reed";
const CASES: Case[] = [
  { item: "A", where: "players", lang: "en", asker: ADMIN, body: "@Match Time swap Sam with Alex", why: swapNotDoneWhy({ kind: "no-player", a: "Sam", b: "Alex" }), good: "says Sam and Alex are not in this week's squad or on the bench, asks for two players in the squad; never 'I can't swap players', never 'ask an admin'" },
  { item: "A", where: "players", lang: "tr", asker: ADMIN, body: "@Match Time Sam ile Alex'i değiştir", why: swapNotDoneWhy({ kind: "no-player", a: "Sam", b: "Alex" }), good: "the same, in Turkish, plural" },
  { item: "B", where: "players", lang: "en", asker: ADMIN, body: "@Match Time switch the match to 7aside and tell us the current list", alsoDone: SWITCHED("en"), good: "the current list (or the squad from the records); not a word saying the switch was not done or cannot be done" },
  { item: "B", where: "players", lang: "tr", asker: ADMIN, body: "@Match Time maçı 7'li yap ve güncel listeyi söyle", alsoDone: SWITCHED("tr"), good: "the same, in Turkish" },
  { item: "C", where: "organisers", lang: "en", asker: ADMIN, body: "@Match Time I meant the registered players, not asking the teams yet", good: "15 players are registered with the club; never the ratings again" },
  { item: "C", where: "organisers", lang: "tr", asker: ADMIN, body: "@Match Time kayıtlı oyuncuları kastettim, takımları sormuyorum", good: "15 kayıtlı oyuncu; never the ratings again" },
  { item: "D", where: "players", lang: "en", asker: MEMBER, body: "@Match Time who's on the waiting list?", good: "On the bench: 1. Max Penn, 2. Ned Rowe; says 'the bench', never 'waiting list'" },
  { item: "D", where: "players", lang: "tr", asker: MEMBER, body: "@Match Time bekleme listesinde kim var?", good: "Yedekte: 1. Max Penn, 2. Ned Rowe; 'yedek', never 'bekleme listesi'" },
];

const only = (process.env.ONLY ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);

async function main() {
  const now = new Date("2026-11-17T12:00:00.000Z");
  for (const [i, c] of CASES.entries()) {
    if (only.length && !only.includes(i + 1)) continue;
    const st = state(c.lang);
    const f = features(c.lang);
    const organisers = c.where === "organisers";
    const wa = `wa-${i + 1}`;
    console.log(`\n── ${i + 1}. [${c.item}] ${organisers ? "HQ" : "players' group"} (${c.lang}), ${c.asker === ADMIN ? "an admin" : "a member"}: ${c.body}`);
    const chat = organisers ? HQ_CHAT(c.lang) : [];
    const res = await runAnswerBatch({
      orgId: "org-live",
      now,
      messages: [
        {
          waMessageId: wa,
          body: c.body,
          authorName: c.asker,
          senderUserId: id(c.asker),
          senderName: c.asker,
          tagged: true,
          addressed: true,
          // A: the team path's dead end. B: the admin owner's message, which
          // also asks. C and D: a question.
          route: (c.item === "A" ? "balancer" : c.item === "B" ? "admin_ops" : "question") as Route,
          gated: false,
        },
      ],
      history: chat.map((l) => ({ author: l.author, body: l.body })),
      ...(organisers ? { weekChat: async () => chat } : {}),
      expectedMatchId: st.matchId,
      enabled: new Set<Route>(["question", "balancer", "admin_ops"]),
      ...(c.why !== undefined ? { deadEnds: new Map([[wa, { why: c.why }]]) } : {}),
      ...(c.alsoDone ? { alsoAsks: new Set([wa]), alsoDone: new Map([[wa, [c.alsoDone]]]) } : {}),
      ...(organisers ? { audience: "organisers" as const } : {}),
      deps: {
        model,
        loadState: async () => st,
        loadFeatures: async () => f,
        loadClub: async () => CLUB,
        loadStats: async () => TABLES,
        loadStatsPeriod: async () => ({ appearances: [], ratings: [], mom: [] }),
        loadChemistry: async () => null,
        loadResults: async () => ({ since: null, more: false, rows: [{ dayLabel: c.lang === "tr" ? "10 Kas Sal" : "Tue 10 Nov", redLabel: "Bibs", yellowLabel: "Non Bibs", red: 7, yellow: 5 }] }),
        loadPayments: async () => ({ kind: "not_tracked" }),
        loadRatingProgress: async () => ({ ok: false }) as never,
        loadClubFacts: async () => CLUB_FACTS,
        loadLastMatchRatings: async () => LAST_RATINGS,
        loadOwnStats: async () => null,
        helpReply: async (req, feats, asker) =>
          organisers
            ? buildHqHelp({ lang: c.lang, squad: true, graphics: true, picks: false, paid: false, free: false, pool: false, features: helpFeaturesFrom(feats, CLUB_FACTS) })
            : clubHelpReply({ orgId: "org-live", req, features: feats, audience: asker.admin ? "admin" : "group", poolEnv: async () => ({}), club: CLUB_FACTS }),
      },
    });
    const o = res.outcomes.get(wa) ?? res.alsoAnswered.get(wa);
    if (o?.reply) console.log(`   REPLY: ${o.reply.split("\n").join("\n          ")}`);
    else console.log(`   NO ANSWER: ${res.degradations.join(" | ") || "none owned"}`);
    console.log(`   good: ${c.good}`);
  }
  console.log(`\n${calls} model call(s), $${usd.toFixed(4)} on the dev key.`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${calls} model call(s), $${usd.toFixed(4)} on the dev key.`);
  process.exit(1);
});
