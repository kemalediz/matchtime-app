/**
 * WHO THE QUESTION IS ABOUT: THE PAID CHECK (2026-11-18, the fixes carried
 * from #604 onto main).
 *
 * ⚠️  THIS CALLS THE REAL MODEL AND COSTS MONEY. Dev key only, each case
 *     once, hard cap MAX_USD (default $0.50).
 *
 * No prompt text changed. What the unified answer is SHOWN changed:
 *
 *   DM: no "THE PLAYER THE QUESTION IS ABOUT: <the asker>" block (it was a
 *   guess, and "what is Bruno's rating?" had the asker's numbers under it);
 *   the asker's own block is no longer headed "they asked about themselves",
 *   and carries their club rating and rank wherever they rank, and their
 *   pairings with the numbers.
 *   Groups: a question naming someone who does not resolve to one member has
 *   no subject block; "I", "myself", "beni", "bana" are the asker.
 *
 * DM cases go through `answerUnified` with the input `loadUnifiedDmInput`
 * builds (its pure parts; made-up club, no database). The wrong-player DM
 * case also runs the OLD context, for the side by side. Group cases go
 * through the REAL path (`runAnswerBatch`, the real question extractor).
 * EN and TR. Made-up people.
 *
 *   node --env-file=/path/to/repo/.env ./node_modules/.bin/tsx scripts/live-check-unified-subject.ts
 *
 * DRY=1: a stub model, $0 (SHOW_TURN=1 prints each turn). ONLY=1,3: those
 * cases. Judged by reading. WHAT ONE PASS CANNOT PROVE: an occasional miss
 * can pass once and fail live.
 */
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { anthropicModel, type PipelineModel } from "../src/lib/pipeline/llm.ts";
import { runAnswerBatch } from "../src/lib/pipeline/answer-batch.ts";
import { answerUnified, type UnifiedAnswerInput } from "../src/lib/pipeline/unified-answer.ts";
import { formatOwnStatsLines } from "../src/lib/dm-qa.ts";
import { askerPairingLines, askerRatingLine } from "../src/lib/unified-dm.ts";
import { noReplyContext, renderReplyContext } from "../src/lib/reply-context.ts";
import type { OrgFeatures } from "../src/lib/org-features.ts";
import type { HelpClubFacts } from "../src/lib/help-club-facts.ts";
import type { ClubSnapshot, Member, Route, SquadState, StatsSnapshot } from "../src/lib/pipeline/types.ts";

const MAX_USD = Number(process.env.MAX_USD ?? 0.5);
const DRY = process.env.DRY === "1";
if (!DRY) spendDevApiKeyOrExit("the unified subject live check");

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
    if (req.label === "extractor:question") console.log(`   extractor said: ${r.text}`);
    return r;
  },
};

// ── A made-up club ───────────────────────────────────────────────────────
const NAMES = ["Bruno Carr", "Alex Dale", "Alex Ewing", "Cosmo Finch", "Dario Gill", "Eli Brook", "Finn Marsh", "Gus Reed", "Hal Pike", "Ivo Lane", "Jem Cole", "Alfie Brook", "Kit Vale"];
const id = (n: string) => `u-${n.toLowerCase().replace(/\W+/g, "-")}`;
const roster: Member[] = NAMES.map((n, i) => ({ userId: id(n), name: n, isAdmin: i < 1, hasPhone: true }));
const ASKER = "Alfie Brook";

function state(lang: "en" | "tr"): SquadState {
  let pos = 0;
  return {
    matchId: "m-tue",
    maxPlayers: 14,
    kickoffLabel: lang === "tr" ? "Sal 24 Kas, 21:30" : "Tue 24 Nov, 21:30",
    matchLabel: lang === "tr" ? "Sal 24 Kas, 21:30" : "Tue 24 Nov, 21:30",
    venue: "Riverside Arena",
    rows: NAMES.slice(0, 10).map((n) => ({ userId: id(n), status: "CONFIRMED" as const, position: ++pos })),
    roster,
    openOffers: [],
    teams: [],
    teamLabels: ["Bibs", "Non Bibs"],
    completedMatch: null,
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: true, reminders: true, language: lang, benchPickMode: "first-come", listAnnouncer: "matchtime" },
    smallerFormats: [],
    guestAskedUserIds: [],
    payments: null,
    ratingProgress: null,
  } as SquadState;
}

const CLUB: ClubSnapshot = { collectorName: "Bruno Carr", feePerPlayer: 6, feeSplitTotal: false, teamsReady: "18:00" };
const CLUB_FACTS: HelpClubFacts = { pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 0 } };
// The asker, Alfie, is 12th: outside the top 10 the group table shows.
const RATINGS = NAMES.filter((n) => n !== "Kit Vale").map((n, i) => ({ userId: id(n), name: n, avg: Number((7.9 - i * 0.1).toFixed(1)), games: 5 + (i % 3), rank: i + 1, delta: 0 }));
const TABLES: Omit<StatsSnapshot, "chemistry" | "generic" | "periods"> = {
  fullTableUrl: "https://matchtime.ai/profile/stats",
  ratings: RATINGS,
  mom: [],
  elo: [],
  teamOfSeason: null,
  mrReliable: [],
  aliases: [],
  appearances: [],
  recordsStart: { matches: new Date("2026-09-04T19:30:00.000Z"), mom: new Date("2026-09-04T19:30:00.000Z") },
  completedMatches: 10,
};
const MINE = {
  gamesPlayed: 7,
  totalOrgMatches: 10,
  attendanceRate: 70,
  avgRating: 6.9,
  fieldAvgSeason: 7.0,
  momCount: 1,
  record: { w: 4, d: 1, l: 2 },
  form: { last5Avg: 7.0, trend: "steady" },
  chemistry: {
    bestByWinRate: { userId: id("Cosmo Finch"), name: "Cosmo Finch", gamesTogether: 5, wins: 4, winRate: 0.8, myAvgWith: 7.2 },
    bestByRating: { userId: id("Dario Gill"), name: "Dario Gill", gamesTogether: 4, wins: 2, winRate: 0.5, myAvgWith: 7.5 },
  },
  rivalry: { nemesis: { userId: id("Eli Brook"), name: "Eli Brook", gamesAgainst: 4, wins: 1, losses: 3, winRate: 0.25 } },
};
const features = (lang: "en" | "tr") =>
  ({ botEnabled: true, attendance: true, bench: true, teamBalancing: true, momVoting: true, playerRating: true, reminders: true, statsQa: true, paymentTracking: false, paymentCollection: false, squadFromList: false, language: lang, squadMode: "weekly", benchPickMode: "first-come" }) as unknown as OrgFeatures;

/** The DM input as `loadUnifiedDmInput` builds it, NEW or OLD (main before). */
function dmInput(lang: "en" | "tr", question: string, variant: "new" | "old"): UnifiedAnswerInput {
  const base = formatOwnStatsLines({ ...MINE, bestPartner: MINE.chemistry.bestByWinRate.name, nemesis: MINE.rivalry.nemesis.name });
  const st = { ...state(lang), club: CLUB };
  const stats: StatsSnapshot = { ...TABLES, chemistry: {}, generic: {}, periods: {} };
  let own: string;
  if (variant === "new") {
    const lines = [
      ...base.filter((l) => !l.startsWith("- Best partnership:") && !l.startsWith("- Nemesis:")),
      ...askerPairingLines(MINE as never),
    ].map((l) => l.replace(/^- Average rating:/, "- Average of all the ratings they received (their stats page):"));
    own = ["THE ASKER'S OWN STATS:", ...lines.slice(1), askerRatingLine(RATINGS, id(ASKER))].join("\n");
  } else {
    own = ["THE ASKER'S OWN STATS (they asked about themselves):", ...base.slice(1)].join("\n");
    stats.chemistry[id(ASKER)] = { userId: id(ASKER), name: ASKER, bestByWinRate: null, bestByRating: null, nemesis: null } as never;
  }
  return {
    audience: "dm",
    state: st,
    squadKnown: true,
    stats,
    periods: [],
    person: variant === "new" ? null : { userId: id(ASKER), self: true },
    results: null,
    payments: null,
    ratingProgress: null,
    clubFacts: CLUB_FACTS,
    squadMode: "weekly",
    own: [own],
    dmChat: renderReplyContext(noReplyContext(new Date("2026-11-18T12:00:00Z"))),
    history: [],
    lastBotPost: null,
    reply: null,
    now: new Date("2026-11-18T12:00:00Z"),
    question,
    askerUserId: id(ASKER),
    askerName: ASKER,
    askerIsAdmin: false,
  };
}

interface Case {
  where: "dm" | "players" | "organisers";
  lang: "en" | "tr";
  body: string;
  old?: true;
  good: string;
}
const CASES: Case[] = [
  { where: "dm", lang: "en", body: "what is Bruno's rating?", old: true, good: "Bruno Carr 7.9 (no. 1); never Alfie's 6.9 or no. 12 as Bruno's" },
  { where: "dm", lang: "tr", body: "Bruno'nun puanı kaç?", old: true, good: "Bruno Carr 7,9 (1.); never Alfie's numbers" },
  { where: "dm", lang: "en", body: "what's my rank?", good: "no. 12 with 6.8 (from the club ratings table)" },
  { where: "dm", lang: "tr", body: "sıralamam kaç?", good: "12. sıra, 6,8" },
  { where: "dm", lang: "en", body: "who do I play best with?", good: "Cosmo Finch (4 wins in 5) and/or Dario Gill (7.5 alongside)" },
  { where: "dm", lang: "tr", body: "en iyi kiminle oynuyorum?", good: "Cosmo Finch and/or Dario Gill, in Turkish" },
  { where: "players", lang: "en", body: "@Match Time what is Alex's rating?", good: "both Alexes from the table (Alex Dale 7.8, Alex Ewing 7.7) or asks which; never the asker's numbers as Alex's" },
  { where: "players", lang: "tr", body: "@Match Time Alex'in puanı kaç?", good: "the same, in Turkish" },
  { where: "players", lang: "en", body: "@Match Time who's my nemesis?", good: "extractor personRef 'me'; the subject is the asker (Bruno Carr), who has no pairings on record: says so, never another member's" },
  { where: "players", lang: "tr", body: "@Match Time en zorlandığım rakip kim?", good: "extractor personRef a self word ('me', 'ben...'); the asker's subject block, never another member's" },
];

const only = (process.env.ONLY ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);

async function main() {
  const now = new Date("2026-11-18T12:00:00.000Z");
  for (const [i, c] of CASES.entries()) {
    if (only.length && !only.includes(i + 1)) continue;
    console.log(`\n── ${i + 1}. ${c.where} (${c.lang}): ${c.body}`);
    if (c.where === "dm") {
      for (const v of c.old ? (["old", "new"] as const) : (["new"] as const)) {
        const g = await answerUnified({ ...dmInput(c.lang, c.body, v), model });
        console.log(`   ${v.toUpperCase()}: ${"text" in g.result ? g.result.text.split("\n").join("\n          ") : `REFUSED (${g.result.rejected})`}`);
      }
    } else {
      const st = state(c.lang);
      const organisers = c.where === "organisers";
      const res = await runAnswerBatch({
        orgId: "org-live",
        now,
        messages: [{ waMessageId: "wa-1", body: c.body, authorName: "Bruno Carr", senderUserId: id("Bruno Carr"), senderName: "Bruno Carr", tagged: true, addressed: true, route: "question" as Route, gated: false }],
        history: [],
        expectedMatchId: st.matchId,
        enabled: new Set<Route>(["question"]),
        ...(organisers ? { audience: "organisers" as const } : {}),
        deps: {
          model,
          loadState: async () => st,
          loadFeatures: async () => features(c.lang),
          loadClub: async () => CLUB,
          loadStats: async () => TABLES,
          loadStatsPeriod: async () => ({ appearances: [], ratings: [], mom: [] }),
          loadChemistry: async () => null,
          loadResults: async () => ({ since: null, more: false, rows: [] }),
          loadPayments: async () => ({ kind: "not_tracked" }),
          loadRatingProgress: async () => ({ ok: false }) as never,
          loadClubFacts: async () => CLUB_FACTS,
          loadLastMatchRatings: async () => null,
          loadOwnStats: async () => null,
          helpReply: async () => "HELP",
        },
      });
      const o = res.outcomes.get("wa-1");
      console.log(`   REPLY: ${o?.reply ? o.reply.split("\n").join("\n          ") : `none (${res.degradations.join(" | ") || "none owned"})`}`);
    }
    console.log(`   good: ${c.good}`);
  }
  console.log(`\n${calls} model call(s), $${usd.toFixed(4)} on the dev key.`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${calls} model call(s), $${usd.toFixed(4)} on the dev key.`);
  process.exit(1);
});
