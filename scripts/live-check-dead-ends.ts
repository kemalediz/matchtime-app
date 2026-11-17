/**
 * DEAD ENDS TO THE UNIFIED ANSWER: THE PAID CHECK (2026-11-17).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only, each case
 *     once, hard cap MAX_USD.
 *
 * A tagged message MatchTime took no action on (the admin extractor's
 * "other", a team change it cannot make, nothing at all) is now answered by
 * the unified answer (`dead-end-answer.ts`), told NOT DONE and shown the
 * group's help menu, instead of a canned line. This drives the REAL prompt
 * through the real path (`runAnswerBatch` with `deadEnds`, the real help
 * menus, the real grounding check), once per case, against a made-up club
 * (no database, nothing sent). ONE model call per case.
 *
 *   node --env-file=/path/to/repo/.env ./node_modules/.bin/tsx scripts/live-check-dead-ends.ts
 *
 * Prints, per case: who asks where, the reply verbatim (or the reason it
 * was refused: the canned line is then said), and what a good reply does.
 * Judged by reading. Spends ANTHROPIC_API_KEY_DEV only (refuses without
 * it). WHAT ONE PASS CANNOT PROVE: an occasional miss can pass once and
 * fail live.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { clubHelpReply } from "../src/lib/help-answer.ts";
import { buildHqHelp } from "../src/lib/admin-group-help.ts";
import { helpFeaturesFrom } from "../src/lib/onboarding-conversation.ts";
import type { OrgFeatures } from "../src/lib/org-features.ts";
import type { HelpClubFacts } from "../src/lib/help-club-facts.ts";
import type { ClubSnapshot, Member, Route, SquadState, StatsSnapshot } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 1);

// DRY=1: a stub model, $0, to check the wiring before the one paid pass.
const DRY = process.env.DRY === "1";
if (!DRY) spendDevApiKeyOrExit("the dead-ends live check");

let calls = 0;
let usd = 0;
const inner: PipelineModel = DRY
  ? {
      name: "dry",
      async complete(req) {
        if (process.env.SHOW_TURN === "1") console.log(req.user);
        return { text: JSON.stringify({ answer: "Dry run." }), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
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
    return r;
  },
};

// ── A made-up club: 7 a side, MatchTime posts the list ──────────────────
const NAMES = ["Ava Stone", "Ben Hale", "Cem Aksoy", "Deniz Uçar", "Eli Brook", "Finn Marsh", "Gus Reed", "Hal Pike", "Ivo Lane", "Jem Cole", "Kit Vale", "Lev Ash", "Max Penn", "Ned Rowe", "Oz Kerr"];
const id = (n: string) => `u-${n.toLowerCase().replace(/\W+/g, "-")}`;
const roster: Member[] = NAMES.map((n, i) => ({ userId: id(n), name: n, isAdmin: i < 2, hasPhone: true }));
const SQUAD = NAMES.slice(0, 11);
const BENCH = ["Max Penn", "Ned Rowe"];

function state(opts: { lang: "en" | "tr"; scored: boolean }): SquadState {
  let pos = 0;
  return {
    matchId: "m-fri",
    maxPlayers: 14,
    kickoffLabel: opts.lang === "tr" ? "Cum 20 Kas, 20:30" : "Fri 20 Nov, 20:30",
    matchLabel: opts.lang === "tr" ? "Cum 20 Kas, 20:30" : "Fri 20 Nov, 20:30",
    venue: "Riverside Arena",
    rows: [
      ...SQUAD.map((n) => ({ userId: id(n), status: "CONFIRMED" as const, position: ++pos })),
      ...BENCH.map((n) => ({ userId: id(n), status: "BENCH" as const, position: ++pos })),
    ],
    roster,
    openOffers: [],
    teams: [],
    teamLabels: ["Bibs", "Non Bibs"],
    // "bibs 9 no bibs 4" with no game finished: the last game has its score.
    completedMatch: {
      id: "m-last",
      kickoffLabel: opts.lang === "tr" ? "Cum 13 Kas, 20:30" : "Fri 13 Nov, 20:30",
      status: "COMPLETED",
      isHistorical: false,
      redScore: opts.scored ? 7 : null,
      yellowScore: opts.scored ? 5 : null,
      participantUserIds: [],
    },
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: true, reminders: true, language: opts.lang, benchPickMode: "first_come", listAnnouncer: "matchtime" },
    smallerFormats: [],
    guestAskedUserIds: [],
    payments: null,
    ratingProgress: null,
  } as SquadState;
}

const CLUB: ClubSnapshot = { collectorName: "Ben Hale", feePerPlayer: 6, feeSplitTotal: false, teamsReady: "18:00" };
const CLUB_FACTS: HelpClubFacts = { pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 2 } };
const TABLES: Omit<StatsSnapshot, "chemistry" | "generic" | "periods"> = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: [{ userId: id("Cem Aksoy"), name: "Cem Aksoy", avg: 7.4, games: 6, rank: 1, delta: 0 }],
  mom: [{ userId: id("Eli Brook"), name: "Eli Brook", wins: 2 }],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  appearances: [{ userId: id("Ava Stone"), name: "Ava Stone", matches: 8 }, { userId: id("Cem Aksoy"), name: "Cem Aksoy", matches: 7 }],
  recordsStart: { matches: new Date("2026-09-04T19:30:00.000Z"), mom: new Date("2026-09-04T19:30:00.000Z") },
  completedMatches: 10,
};
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

const HISTORY_EN = [
  { author: "Gus Reed", body: "who's got the bibs this week?" },
  { author: "Hal Pike", body: "I think Finn has them" },
  { author: "MatchTime", body: "That's 11 of 14 for Fri 20:30. 3 places open, say *IN* to take one." },
];
const HISTORY_TR = [
  { author: "Gus Reed", body: "yelekler kimde bu hafta?" },
  { author: "Hal Pike", body: "Finn'de galiba" },
  { author: "MatchTime", body: "Cuma 20:30 için 14 kişiden 11 kişi var. 3 yer boş, almak için *IN* yazın." },
];

interface Case {
  where: "players" | "organisers";
  lang: "en" | "tr";
  asker: string;
  body: string;
  scored?: boolean;
  good: string;
}
const ADMIN = "Ava Stone";
const MEMBER = "Gus Reed";
const CASES: Case[] = [
  { where: "players", lang: "en", asker: ADMIN, body: "@Match Time book the pitch for Friday", good: "says it can't book pitches, offers what it can (cancel or move a game, partner clubs)" },
  { where: "players", lang: "tr", asker: ADMIN, body: "@Match Time cuma için sahayı ayarla", good: "the same, in Turkish, plural" },
  { where: "players", lang: "en", asker: MEMBER, body: "@Match Time bibs 9 no bibs 4", scored: true, good: "nothing recorded; the last game already has its score (Bibs 7, Non Bibs 5); no claim of saving" },
  { where: "players", lang: "tr", asker: MEMBER, body: "@Match Time yelekliler 9 yeleksizler 4", scored: true, good: "the same, in Turkish" },
  { where: "players", lang: "en", asker: MEMBER, body: "@Match Time do the thing", good: "one short clarifying question" },
  { where: "players", lang: "tr", asker: MEMBER, body: "@Match Time şu işi hallet", good: "one short clarifying question, in Turkish" },
  { where: "players", lang: "en", asker: MEMBER, body: "@Match Time you're useless 😂", good: "one short friendly line, never 'didn't catch'" },
  { where: "players", lang: "tr", asker: MEMBER, body: "@Match Time hiçbir işe yaramıyorsun 😂", good: "one short friendly line, in Turkish" },
  { where: "players", lang: "en", asker: MEMBER, body: "@Match Time rename the teams to Sharks and Wolves", good: "can't rename teams; no claim it did" },
  { where: "players", lang: "en", asker: ADMIN, body: "@Match Time order new bibs for the club", good: "can't order things; what it can do instead" },
  { where: "organisers", lang: "en", asker: ADMIN, body: "@Match Time book the pitch for Friday", good: "HQ: can't book; cancel or move a game, ask partner clubs" },
  { where: "organisers", lang: "tr", asker: ADMIN, body: "@Match Time cuma için hakem ayarla", good: "HQ, Turkish: can't arrange a referee; what it can do" },
];

const only = (process.env.ONLY ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);

async function main() {
  const now = new Date("2026-11-17T12:00:00.000Z");
  for (const [i, c] of CASES.entries()) {
    if (only.length && !only.includes(i + 1)) continue;
    const st = state({ lang: c.lang, scored: c.scored ?? true });
    const f = features(c.lang);
    const organisers = c.where === "organisers";
    console.log(`\n── ${i + 1}. ${organisers ? "HQ" : "players' group"} (${c.lang}), ${c.asker === ADMIN ? "an admin" : "a member"}: ${c.body}`);
    const res = await runAnswerBatch({
      orgId: "org-live",
      now,
      messages: [{ waMessageId: `wa-${i + 1}`, body: c.body, authorName: c.asker, senderUserId: id(c.asker), senderName: c.asker, tagged: true, addressed: true, route: "admin_ops" as Route, gated: false }],
      history: c.lang === "tr" ? HISTORY_TR : HISTORY_EN,
      expectedMatchId: st.matchId,
      enabled: new Set<Route>(["question"]),
      unified: true,
      deadEnds: new Set([`wa-${i + 1}`]),
      ...(organisers ? { audience: "organisers" as const } : {}),
      deps: {
        model,
        loadState: async () => st,
        loadFeatures: async () => f,
        loadClub: async () => CLUB,
        loadStats: async () => TABLES,
        loadStatsPeriod: async () => ({ appearances: [], ratings: [], mom: [] }),
        loadChemistry: async () => null,
        loadResults: async () => ({ since: null, more: false, rows: c.scored === false ? [] : [{ dayLabel: c.lang === "tr" ? "13 Kas Cum" : "Fri 13 Nov", redLabel: "Bibs", yellowLabel: "Non Bibs", red: 7, yellow: 5 }] }),
        loadPayments: async () => ({ kind: "not_tracked" }),
        loadRatingProgress: async () => ({ ok: false }) as never,
        loadClubFacts: async () => CLUB_FACTS,
        loadLastMatchRatings: async () => null,
        loadOwnStats: async () => null,
        helpReply: async (req, feats, asker) =>
          organisers
            ? buildHqHelp({ lang: c.lang, squad: true, graphics: true, picks: false, paid: false, free: false, pool: false, features: helpFeaturesFrom(feats, CLUB_FACTS) })
            : clubHelpReply({ orgId: "org-live", req, features: feats, audience: asker.admin ? "admin" : "group", poolEnv: async () => ({}), club: CLUB_FACTS }),
      },
    });
    const o = res.outcomes.get(`wa-${i + 1}`);
    if (o?.reply) console.log(`   REPLY: ${o.reply.split("\n").join("\n          ")}`);
    else console.log(`   NO ANSWER (the canned line is said): ${res.degradations.filter((d) => /unified/.test(d)).join(" | ") || "none owned"}`);
    console.log(`   good: ${c.good}`);
  }
  console.log(`\n${calls} model call(s), $${usd.toFixed(4)} on the dev key.`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${calls} model call(s), $${usd.toFixed(4)} on the dev key.`);
  process.exit(1);
});
