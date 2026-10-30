/**
 * WHEN MATCHTIME MAY BUILD THE TEAMS: on match day, a fact.
 *
 * Written 2026-09-29 after the Sutton FC incident of Thu 24 Sep, when a
 * joke about pairings built the teams five days early. Kemal's rule:
 * teams are built only on match day (the London calendar date of the
 * match). `team-ops-engine-batch.ts` checks it after the teams extractor.
 *
 * The word lists that also stood here (`isExplicitTeamBuildRequest`,
 * `isClearTeamsRequest`, English and Turkish stems) are deleted
 * (2026-10-30, Kemal: "no string parsing at all"): whether a message asks
 * for new teams is the teams extractor's reading.
 *
 * Pure. Nothing imports the database.
 */
/** Europe/London calendar date, "YYYY-MM-DD". DST-safe via Intl. */
export function londonDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Is `now` on the London calendar date of the match's kickoff? */
export function isMatchDay(matchDate: Date, now: Date): boolean {
  return londonDateKey(matchDate) === londonDateKey(now);
}
