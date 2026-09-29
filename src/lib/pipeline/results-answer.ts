/**
 * RECENT RESULTS IN THE GROUP, ANSWERED BY CODE (2026-09-29).
 *
 * The incident, Sutton FC, 2026-09-29 22:18 UTC: "@Match Time give us the
 * scores of the last 5 matches" was answered "Tue 21:30: Red 5 - 4
 * Yellow. Red won.", the last match only. The question extractor read
 * `topic: "score"` and nothing else, because a `score` question had no
 * field for HOW MANY or WHICH PERIOD; the engine could only answer the
 * last match.
 *
 * The model still only CLASSIFIES. It reads "the last 5", "son 5 maç",
 * "this season" into the SAME fields a stats question uses (`listSize`,
 * `period`); no count or period is ever read from the text by code. This
 * module turns those fields into a plan and renders the answer from a
 * `RecentResults` snapshot that `load-results.ts` reads from the club's
 * own matches. Every date and number the group sees is the database's.
 *
 * With no count and no period the answer is exactly what it was before:
 * the last match played, from `state.completedMatch` (`answer_score`),
 * which also knows how to say "nobody reported a score for Tuesday".
 *
 * PURE. No clock, no Prisma: `compose.ts` imports this.
 */
import { t } from "../i18n/t";
import { cutsTheRecord, periodKey } from "./stats-period";
import type { QuestionFacts, RecentResults, StatsPeriod } from "./types";

/** The most results the group is sent in one answer. */
export const RESULTS_MAX = 10;

export type ResultsPlan =
  | { kind: "last_match" }
  | { kind: "list"; limit: number; asked: number | null; period: StatsPeriod | null };

/**
 * PURE. What a `score` question asks for. No count and no period (or a
 * count of one) is the last match, today's answer; anything else is a
 * list, capped at `RESULTS_MAX`, with the number asked kept so the
 * answer can say when it posted fewer.
 */
export function planResultsQuestion(f: QuestionFacts): ResultsPlan {
  const asked = typeof f.listSize === "number" && f.listSize >= 1 ? Math.floor(f.listSize) : null;
  const period = f.period ?? null;
  if (period === null && (asked === null || asked === 1)) return { kind: "last_match" };
  return { kind: "list", limit: Math.min(asked ?? RESULTS_MAX, RESULTS_MAX), asked, period };
}

/** PURE. The key a plan's results are loaded and looked up under: the
 *  season, all time and no period are all the whole record. */
export function resultsKey(period: StatsPeriod | null | undefined): string {
  return cutsTheRecord(period) ? periodKey(period) : "all";
}

/**
 * PURE. The group's answer, or `null` when the results were not loaded
 * (the composer then says nothing and the batch disowns the message
 * with a receipt, the same as every other targeted read).
 */
export function renderResults(
  plan: { limit: number; asked: number | null; period: StatsPeriod | null },
  snap: RecentResults | undefined | null,
  lang: string,
): string | null {
  if (!snap) return null;
  const s = t(lang);
  const cut = cutsTheRecord(plan.period);
  const rows = snap.rows.slice(0, plan.limit);
  if (rows.length === 0) {
    return cut && plan.period ? s.results_none_when({ period: plan.period }) : s.results_none;
  }
  // A cutting period with no count is headed by the period ("Results this
  // month"); everything else by how many it lists ("Last 5 results").
  const byCount = !cut || plan.asked !== null;
  const lines = [s.results_head({ n: rows.length, period: plan.period, byCount })];
  for (const r of rows) {
    lines.push(
      s.results_row({
        dayLabel: r.dayLabel,
        redLabel: r.redLabel,
        red: r.red,
        yellow: r.yellow,
        yellowLabel: r.yellowLabel,
        winnerLabel: r.red === r.yellow ? null : r.red > r.yellow ? r.redLabel : r.yellowLabel,
      }),
    );
  }
  // Fewer than asked: say why, never leave the group to wonder.
  const moreExist = snap.rows.length > rows.length || snap.more;
  if (plan.asked !== null && rows.length < plan.asked) {
    lines.push(moreExist ? s.results_capped({ max: RESULTS_MAX }) : s.results_all_i_have);
  } else if (plan.asked === null && cut && moreExist) {
    lines.push(s.results_latest({ n: rows.length }));
  }
  return lines.join("\n");
}
