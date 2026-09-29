/**
 * THE CLUB'S RECENT RESULTS, READ (2026-09-29).
 *
 * The fourth targeted read `loadSquadState` does not do, after
 * `payments`, `ratingProgress` and the stats tables, and for the same
 * reasons: a results question is a handful of messages a season, and
 * `compose.ts` may not import Prisma. `answer-batch.ts` calls this only
 * when a `score` question asked for several results or a period, and
 * hands the result down as `SquadState.results`.
 *
 * WHICH MATCHES. This club's (`activity.orgId`) matches with BOTH scores
 * recorded, whose kickoff plus duration has passed, in the three
 * statuses the score route accepts (`load-state.ts`'s `completedMatch`
 * says why a scored match is not always COMPLETED). Most recent first,
 * at most `RESULTS_MAX`; one more is read so the answer knows whether
 * there are more. `since` cuts the span; null is the whole record.
 *
 * Team names are each match's own (`resolveTeamLabels`, match then org
 * then sport), so a renamed night reads as it was played.
 *
 * READ-ONLY BY CONSTRUCTION: every statement is a find.
 */
import { db } from "../db";
import { dayLabel } from "../i18n/dates";
import { resolveTeamLabels } from "../team-labels";
import { RESULTS_MAX } from "./results-answer";
import type { RecentResults } from "./types";

const PLAYED_STATUSES = ["TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED"] as const;

export async function loadRecentResults(
  orgId: string,
  since: Date | null,
  now: Date,
  lang: string,
): Promise<RecentResults> {
  const [org, matches] = await Promise.all([
    db.organisation.findUnique({ where: { id: orgId }, select: { teamLabels: true } }),
    db.match.findMany({
      where: {
        activity: { orgId },
        status: { in: [...PLAYED_STATUSES] },
        date: since ? { gte: since, lte: now } : { lte: now },
        redScore: { not: null },
        yellowScore: { not: null },
      },
      select: {
        date: true,
        redScore: true,
        yellowScore: true,
        teamLabels: true,
        activity: { select: { matchDurationMins: true, sport: { select: { teamLabels: true } } } },
      },
      orderBy: { date: "desc" },
      // A little headroom for a scored match that has somehow not ended.
      take: RESULTS_MAX + 3,
    }),
  ]);
  const ended = matches.filter(
    (m) => m.date.getTime() + m.activity.matchDurationMins * 60 * 1000 <= now.getTime(),
  );
  const rows = ended.slice(0, RESULTS_MAX).map((m) => {
    const [redLabel, yellowLabel] = resolveTeamLabels({ teamLabels: m.teamLabels }, org, m.activity.sport, lang);
    return { dayLabel: dayLabel(lang, m.date), redLabel, yellowLabel, red: m.redScore!, yellow: m.yellowScore! };
  });
  return { since, rows, more: ended.length > RESULTS_MAX };
}
