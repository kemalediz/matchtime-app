/**
 * A DM QUESTION (Kemal, 2026-11-10; the only DM answer since 2026-11-18).
 *
 * A private question is answered by the same answer step
 * as the players' group and HQ (`pipeline/unified-answer.ts`), over the same
 * context of the club's data, with the DM's audience: the squad and bench by
 * name (as the DM answer has always shown them), the asker's OWN stats and
 * OWN payments (the DM's own blocks, `dm-qa.ts`), who has no number on record
 * and who has rated only for an organiser, and never another player's money.
 *
 * This module only READS (the one exception, as before, is the pay link the
 * asker's own payment block mints through `loadMyPayments`, exactly what the
 * DM answer does today). The answer itself is `answerUnified`.
 */
import type { UnifiedAnswerInput } from "./pipeline/unified-answer";
import type { ReplyContext } from "./reply-context";
import { renderReplyContext } from "./reply-context";
import { formatOwnStatsLines } from "./dm-qa";
import { formatMyPaymentsBlock } from "./my-payments-rules";
import type { Lang } from "./i18n/lang";
import type { StatsPeriod, StatsSnapshot } from "./pipeline/types";
import type { PlayerSeasonStats } from "./player-stats";
import { GROUP_RATINGS_MIN_GAMES } from "./pipeline/stats-limits";

const DM_PERIODS: ReadonlyArray<readonly [string, StatsPeriod]> = [
  ["the last 30 days", { kind: "last", count: 30, unit: "day" }],
  ["this year", { kind: "this", unit: "year" }],
];

/**
 * THE ASKER'S OWN STATS as one block, for HQ's unified answer (2026-11-11,
 * "what is my rating?" asked by an organiser): the DM's own lines under a
 * heading that is not "you", which in the answer's context is MatchTime.
 * Null when MatchTime has no stats for them.
 *
 * `aboutThemselves`: HQ adds the block only when the question is about the
 * asker (its extractor said so), and says so. A DM adds it to every
 * question and cannot know who a question names, so it never says so
 * (review of #595, 2026-11-15: "what is Bruno's rating?" had the asker's
 * stats headed "they asked about themselves").
 *
 * `pairings` (a DM, review of #604): the asker's best team-mates and nemesis
 * WITH the numbers behind them, in place of the bare names, from the same
 * season stats the player's own stats page shows, so the DM can never
 * contradict that page.
 */
export async function loadAskerOwnStats(
  orgId: string,
  userId: string,
  aboutThemselves = true,
  opts: { pairings?: boolean } = {},
): Promise<string | null> {
  const { loadPlayerSeasonStats } = await import("./player-stats");
  const mine = await loadPlayerSeasonStats(orgId, userId);
  if (!mine) return null;
  let lines = formatOwnStatsLines({
    gamesPlayed: mine.gamesPlayed,
    totalOrgMatches: mine.totalOrgMatches,
    attendanceRate: mine.attendanceRate,
    avgRating: mine.avgRating,
    fieldAvgSeason: mine.fieldAvgSeason,
    momCount: mine.momCount,
    record: mine.record,
    form: { last5Avg: mine.form.last5Avg, trend: mine.form.trend },
    bestPartner: mine.chemistry.bestByWinRate?.name ?? null,
    nemesis: mine.rivalry.nemesis?.name ?? null,
  });
  if (opts.pairings) {
    lines = [
      ...lines.filter((l) => !l.startsWith("- Best partnership:") && !l.startsWith("- Nemesis:")),
      ...askerPairingLines({ chemistry: mine.chemistry, rivalry: mine.rivalry }),
    ];
  }
  const heading = aboutThemselves ? "THE ASKER'S OWN STATS (they asked about themselves):" : "THE ASKER'S OWN STATS:";
  return [heading, ...lines.slice(1)].join("\n");
}

/**
 * PURE. The asker's own place in the club ratings table, for THE ASKER'S
 * OWN STATS in a DM (review of #604, 2026-11-16). The DM has no subject
 * block (`loadUnifiedDmInput`), and the table it is shown stops at the top
 * 10, so without this line "what's my rank?" from the 12th had nothing to be
 * answered from. Their own, so given wherever they rank.
 *
 * Not in the table is said as the rule the table keeps: it leaves out
 * players with fewer than the minimum of rated matches AND players who have
 * not played in three months (`loadRatingLeaderboard`), and these rows do
 * not say which, so neither does the line. It also leaves out the club's
 * guests (partner clubs, the player pool: `loadGuestUserIds`), which is
 * known, and said.
 */
export function askerRatingLine(ratings: StatsSnapshot["ratings"], userId: string, opts: { guest?: boolean } = {}): string {
  const r = ratings.find((x) => x.userId === userId);
  const label = "- Club rating (their row in the club ratings table):";
  if (r) return `${label} ${r.avg.toFixed(1)} from ${r.games} rated matches, no. ${r.rank}`;
  if (opts.guest) return `${label} not ranked, because they play for this club as a guest, and guests are not in the club ratings table`;
  return `${label} not in the current table, which ranks players with ${GROUP_RATINGS_MIN_GAMES} or more rated matches who have played in the last three months`;
}

/**
 * PURE. The asker's own pairings, for THE ASKER'S OWN STATS in a DM (review
 * of #604): their best team-mates and their nemesis, with the numbers behind
 * them, labelled as theirs. From the season stats the player's stats page
 * shows (`loadPlayerSeasonStats`), its one source.
 */
export function askerPairingLines(s: Pick<PlayerSeasonStats, "chemistry" | "rivalry">): string[] {
  const L: string[] = [];
  const b = s.chemistry.bestByWinRate;
  if (b) L.push(`- Their best team-mate by win rate: ${b.name}, ${b.wins} wins in ${b.gamesTogether} matches together (${Math.round(b.winRate * 100)}%)`);
  const r = s.chemistry.bestByRating;
  if (r && r.myAvgWith !== null) L.push(`- Their best team-mate by rating: ${r.name}, ${r.myAvgWith.toFixed(1)} average alongside them`);
  const n = s.rivalry.nemesis;
  if (n) L.push(`- Their nemesis: ${n.name}, they won ${n.wins} of ${n.gamesAgainst} against them`);
  return L;
}

/** The DM's own-stats line "- Average rating:" says what it is, so the
 *  model can tell it from the club rating beside it: the average of every
 *  rating the asker received, as their stats page shows. */
const OWN_AVERAGE_LABEL = "- Average of all the ratings they received (their stats page):";

/**
 * Everything the DM's unified answer is shown, read from the database.
 * Each read but the club's squad fails soft (left out, logged).
 */
export async function loadUnifiedDmInput(args: {
  orgId: string;
  userId: string;
  askerName: string | null;
  /** An owner, an admin or a superadmin of the club (`inbound-dm.ts`). */
  askerIsAdmin: boolean;
  question: string;
  lang: Lang;
  replyContext: ReplyContext;
  now: Date;
  /** The player pool switch as the request resolved it (`pool/switch-env.ts`,
   *  the same as the players' group and HQ). Absent: closed, the safe side. */
  poolEnv?: () => Promise<Record<string, string | undefined>>;
}): Promise<Omit<UnifiedAnswerInput, never>> {
  const { orgId, userId, now } = args;
  const soft = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      console.error(`[dm-qa] unified ${what} read failed for org=${orgId}:`, err instanceof Error ? err.message : "failed");
      return null;
    }
  };
  const { loadSquadState, loadClubSnapshot, loadRatingProgressSnapshot } = await import("./pipeline/load-state");
  const { loadStatsTables, loadStatsPeriod } = await import("./pipeline/load-stats");
  const { loadRecentResults } = await import("./pipeline/load-results");
  const { loadHelpClubFacts } = await import("./help-club-facts");
  const { periodSince } = await import("./pipeline/stats-period");
  const { loadMyPayments } = await import("./my-payments");

  let state = await loadSquadState(orgId, now);
  const club = await soft("club", () => loadClubSnapshot(orgId, state.matchId));
  if (club) state = { ...state, club };

  let stats: StatsSnapshot | null = null;
  const periods: UnifiedAnswerInput["periods"] = [];
  if (state.features.statsQa) {
    const t = await soft("stats", () => loadStatsTables(orgId, now));
    if (t) {
      // No chemistry here: the asker's own pairings are in their own block,
      // from the stats page's source (`askerPairingLines`).
      stats = { ...t, chemistry: {}, generic: {}, periods: {} };
      for (const [label, p] of DM_PERIODS) {
        const since = periodSince(p, now);
        if (!since) continue;
        const cut = await soft(`stats (${label})`, () => loadStatsPeriod(orgId, since));
        if (cut) periods.push({ label, tables: { since, ...cut } });
      }
    }
  }
  const results = await soft("results", () => loadRecentResults(orgId, null, now, state.features.language));
  const ratingProgress = args.askerIsAdmin ? await soft("rating-progress", () => loadRatingProgressSnapshot(orgId, state.features.language)) : null;
  const clubFacts = await soft("club facts", async () => loadHelpClubFacts(orgId, args.poolEnv ? await args.poolEnv() : {}));
  const { getOrgFeatures } = await import("./org-features");
  const features = await soft("features", () => getOrgFeatures(orgId));

  // THE ASKER'S OWN: his stats and his payments, the DM's own blocks.
  const own: string[] = [];
  // Headed as the asker's, not "YOUR": in the answer's context "you" is
  // MatchTime (ABOUT YOU, 2026-11-11).
  const mine = await soft("own stats", () => loadAskerOwnStats(orgId, userId, false, { pairings: true }));
  // Their club rating and rank, in their own block (the table stops at 10);
  // a guest is told why they are not ranked.
  let rating: string | null = null;
  if (stats) {
    const { loadGuestUserIds } = await import("./ranked-table-activity");
    const { db } = await import("./db");
    const guests = await soft("guests", () => loadGuestUserIds(db, orgId));
    rating = askerRatingLine(stats.ratings, userId, { guest: guests?.has(userId) ?? false });
  }
  const mineLines = mine ? mine.replace(/^- Average rating:/m, OWN_AVERAGE_LABEL).split("\n") : null;
  if (mineLines || rating) own.push([...(mineLines ?? ["THE ASKER'S OWN STATS:"]), ...(rating ? [rating] : [])].join("\n"));
  const fee = state.club?.feePerPlayer ?? null;
  const pay = await soft("own payments", () => loadMyPayments({ orgId, userId, upcomingFee: state.matchId ? fee : null }));
  if (pay) own.push(formatMyPaymentsBlock(pay.payments, args.lang, pay.payLinks).replace(/^YOUR PAYMENTS/, "THE ASKER'S OWN PAYMENTS"));

  // HIS GAME, when he is this club's guest (2026-11-17; cut to it after the
  // review of #621): the facts the welcome DM gave him, and nothing else of
  // the club (`guest-card/context.ts` `guestView`). A guest's membership
  // here is never an ordinary one, so this is any guest with no club of his
  // own asking (`dm-qa.ts` `pickQaOrgAndQuote`).
  const { guestGameBlock } = await import("./guest-card/guest-dm");
  const guest = await soft("guest game", () => guestGameBlock(orgId, userId, now));
  const { guestView } = await import("./guest-card/context");
  const cut = (input: UnifiedAnswerInput): UnifiedAnswerInput => (guest ? guestView(input, guest) : input);

  return cut({
    audience: "dm",
    state,
    squadKnown: true,
    stats,
    periods,
    // No subject block (review of #595, 2026-11-15). A DM has no reading of
    // who its question names, so "THE PLAYER THE QUESTION IS ABOUT: <the
    // asker>" was a guess, and "what is Bruno's rating?" was given the
    // asker's numbers under it. The asker's own numbers, their club rating
    // and rank included, are THE ASKER'S OWN STATS; anyone else's are in
    // the tables, under their own names.
    person: null,
    results,
    payments: null,
    ratingProgress,
    clubFacts,
    squadMode: features?.squadMode === "monthly" ? "monthly" : "weekly",
    own,
    dmChat: renderReplyContext(args.replyContext),
    history: [],
    lastBotPost: null,
    reply: null,
    now,
    question: args.question,
    askerUserId: userId,
    askerName: args.askerName,
    askerIsAdmin: args.askerIsAdmin,
  });
}
