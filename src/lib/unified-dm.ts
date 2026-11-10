/**
 * A DM QUESTION UNDER UNIFIED_ANSWERS (Kemal, 2026-11-10).
 *
 * With the flag on, a private question is answered by the same answer step
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

const DM_PERIODS: ReadonlyArray<readonly [string, StatsPeriod]> = [
  ["the last 30 days", { kind: "last", count: 30, unit: "day" }],
  ["this year", { kind: "this", unit: "year" }],
];

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
  const { loadStatsTables, loadStatsChemistry, loadStatsPeriod } = await import("./pipeline/load-stats");
  const { loadRecentResults } = await import("./pipeline/load-results");
  const { loadHelpClubFacts } = await import("./help-club-facts");
  const { periodSince } = await import("./pipeline/stats-period");
  const { loadPlayerSeasonStats } = await import("./player-stats");
  const { loadMyPayments } = await import("./my-payments");

  let state = await loadSquadState(orgId, now);
  const club = await soft("club", () => loadClubSnapshot(orgId, state.matchId));
  if (club) state = { ...state, club };

  let stats: StatsSnapshot | null = null;
  const periods: UnifiedAnswerInput["periods"] = [];
  if (state.features.statsQa) {
    const t = await soft("stats", () => loadStatsTables(orgId, now));
    if (t) {
      stats = { ...t, chemistry: {}, generic: {}, periods: {} };
      const c = await soft("chemistry", () => loadStatsChemistry(orgId, userId));
      if (c) stats.chemistry[userId] = c;
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
  const clubFacts = await soft("club facts", () => loadHelpClubFacts(orgId, {}));

  // THE ASKER'S OWN: his stats and his payments, the DM's own blocks.
  const own: string[] = [];
  const mine = await soft("own stats", () => loadPlayerSeasonStats(orgId, userId));
  if (mine) {
    own.push(
      formatOwnStatsLines({
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
      }).join("\n"),
    );
  }
  const fee = state.club?.feePerPlayer ?? null;
  const pay = await soft("own payments", () => loadMyPayments({ orgId, userId, upcomingFee: state.matchId ? fee : null }));
  if (pay) own.push(formatMyPaymentsBlock(pay.payments, args.lang, pay.payLinks));

  return {
    audience: "dm",
    state,
    squadKnown: true,
    stats,
    periods,
    person: { userId, self: true },
    results,
    payments: null,
    ratingProgress,
    clubFacts,
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
  };
}
