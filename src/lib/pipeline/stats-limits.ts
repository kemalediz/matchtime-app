/**
 * THE STATS LIMITS (2026-09-23), shared by the unified answer's context,
 * the stats loaders and the website's stats page. Moved here from the
 * stats answers (`stats-answer.ts`), which were deleted on 2026-11-18 with
 * UNIFIED_ANSWERS: the unified answer is shown the tables instead.
 *
 * PURE: no Prisma, no clock.
 */

/** The most rows any list in the group carries (Kemal, 2026-09-23). */
export const GROUP_LIST_CAP = 10;
/** Rated matches a player needs to appear in the group's ratings list. */
export const GROUP_RATINGS_MIN_GAMES = 3;
/** Team of the Season's minimum, everywhere it is produced: the same as
 *  the ratings list above (Kemal, 2026-09-30). */
export const TEAM_OF_SEASON_MIN_GAMES = GROUP_RATINGS_MIN_GAMES;
/** Mirrors `ELO_TOP_MIN_MATCHES` in `match-history.ts`, which applies it;
 *  repeated here only because this module may not import that one. */
export const ELO_TOP_MIN_MATCHES_SHOWN = 3;
