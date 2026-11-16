/**
 * How long a sign-in lasts without being used: Auth.js's own default, 30
 * days, stated here so the /play staff cookie (`visit-rules.ts`) can last no
 * longer than the staff session it stands for (round 7 of #607). A plain
 * constant, with nothing else imported, so the pure rules can read it.
 */
export const AUTH_SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600;
