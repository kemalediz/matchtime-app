/**
 * The HQ outcomes of the organisers' own teams posted untagged
 * (2026-11-27, `hq-teams-posted.ts`). PURE, no imports, so `admin-group.ts`
 * can keep them tick-free without reaching the model door.
 */
export const HQ_TEAMS_POSTED = "hq-teams-posted";
export const HQ_TEAMS_POSTED_SAME = "hq-teams-posted-same";
export const HQ_TEAMS_POSTED_NOT_APPLIED = "hq-teams-posted-not-applied";
/** None of them gets a tick: the posted teams are taken silently. */
export const HQ_TEAMS_POSTED_OUTCOMES: readonly string[] = [HQ_TEAMS_POSTED, HQ_TEAMS_POSTED_SAME, HQ_TEAMS_POSTED_NOT_APPLIED];
