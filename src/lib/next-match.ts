/**
 * THE CLUB'S NEXT MATCH, FOR A DOOR WITH NO CLUB SUMMARY IN HAND (club
 * summary, slice B4, MDs/club-summary-design-2026-11-04.md section 3.16).
 *
 * "The club's next match" is ONE fact: the registration match, where an IN
 * lands and what every answer about "the next match" describes. The club
 * summary carries it (`ClubSummary.nextMatchId`); a door that has no summary
 * (a DM answer, the recruit blast, the dashboard, an HQ command) reads it
 * here, by the same rule over the same matches:
 *   - the candidates: every live match of the club, any date, never a
 *     historical one (`nextMatchWhere`);
 *   - the pick: `selectRegistrationMatch` at the caller's clock: the soonest
 *     live match dated on the London day of `now` or later, and none while a
 *     live match dated before that London day is still in flight;
 *   - "today" is the London day (`londonDayStart`, decision K5).
 *
 * Pure: the caller hands in its own read (`load`), so each keeps its own
 * select or include, and this module imports no database client. The read
 * is always given `nextMatchWhere`, so no door can feed the selector a set
 * of its own (D7: before B4 twelve doors picked "the next match" twelve
 * ways).
 *
 * Two other questions are NOT this one, and each has its own fact:
 *   - the posting rule, "is this the fixture's next match to post about"
 *     (`isNextUpcomingForPosting`, the summary's `MatchFacts.nextForPosting`,
 *     with the cancelled-day hold);
 *   - the last match played (`ClubSummary.lastPlayedMatchId`).
 */
import { londonDayStart } from "./london-time";
import { LIVE_MATCH_STATUSES, selectRegistrationMatch, type SelectableMatch } from "./registration-match-select";

type OrgFilter = string | { in: string[] };

/** The candidates for the club's next match: every live match, any date,
 *  never a historical one. */
export function nextMatchWhere<O extends OrgFilter>(orgId: O) {
  return {
    activity: { orgId },
    isHistorical: false,
    status: { in: [...LIVE_MATCH_STATUSES] },
  };
}

/** THE club's next match at `now`, from the caller's own read of the
 *  candidates (`load` is handed `nextMatchWhere(orgId)`). */
export async function findNextMatch<T extends SelectableMatch>(
  orgId: string,
  now: Date,
  load: (where: ReturnType<typeof nextMatchWhere<string>>) => Promise<T[]>,
): Promise<T | null> {
  return (await findNextMatchOrUnfinished(orgId, now, load)).next;
}

/**
 * The club's next match and, when there is none because the last game is
 * still not finished, that game: the latest live match dated before the
 * London day of `now`, from the same read. Lets a door say why there is no
 * match (the recruit blast's refusal) without a query of its own.
 */
export async function findNextMatchOrUnfinished<T extends SelectableMatch>(
  orgId: string,
  now: Date,
  load: (where: ReturnType<typeof nextMatchWhere<string>>) => Promise<T[]>,
): Promise<{ next: T | null; unfinished: T | null }> {
  const rows = await load(nextMatchWhere(orgId));
  const next = selectRegistrationMatch(rows, now);
  if (next) return { next, unfinished: null };
  const today = londonDayStart(now);
  const before = rows
    .filter((r) => (LIVE_MATCH_STATUSES as readonly string[]).includes(r.status) && r.date < today)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  return { next: null, unfinished: before[0] ?? null };
}

/** The next match of each of several clubs, in one read: the same rule per
 *  club. A club with none (or blocked by a match in flight) is absent. */
export async function findNextMatchPerClub<T extends SelectableMatch & { activity: { orgId: string } }>(
  orgIds: string[],
  now: Date,
  load: (where: ReturnType<typeof nextMatchWhere<{ in: string[] }>>) => Promise<T[]>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  if (orgIds.length === 0) return out;
  const rows = await load(nextMatchWhere({ in: orgIds }));
  for (const orgId of orgIds) {
    const picked = selectRegistrationMatch(
      rows.filter((r) => r.activity.orgId === orgId),
      now,
    );
    if (picked) out.set(orgId, picked);
  }
  return out;
}

/**
 * The match list's "Upcoming" (`/matches`): the selector's candidates dated
 * on the London day of `now` or later, soonest first, so the first of them is
 * the club's next match when nothing is in flight. Today's game stays listed
 * after kickoff until it is completed (before B4 it left the list at kickoff,
 * and was in neither list until the cron completed it), and a cancelled game
 * is not listed as upcoming (before B4 the list had no status filter).
 */
export function upcomingMatchesWhere(orgId: string, now: Date) {
  return { ...nextMatchWhere(orgId), date: { gte: londonDayStart(now) } };
}

/**
 * The selector's block as a query: a live match of the club dated before
 * the London day of `now`, other than `exceptId`. While one exists no later
 * match can be registered for (`attendance.ts`) and the web greys its IN
 * button (`matches/[matchId]/page.tsx`).
 */
export function inFlightWhere(orgId: string, now: Date, exceptId: string) {
  return {
    ...nextMatchWhere(orgId),
    date: { lt: londonDayStart(now) },
    id: { not: exceptId },
  };
}
