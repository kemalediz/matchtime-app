/**
 * When the nightly fixture cron (`/api/cron/generate-matches`) runs: every
 * day at this hour UTC, per its schedule in vercel.json ("0 0 * * *").
 * `generate-upcoming-matches.test.ts` pins the two together. Pure.
 *
 * Read by the admin group's reply to a squad list pasted when the club has
 * no game to put it on (`admin-group-paste.ts`): it says when the next
 * game is made, as a London wall clock (01:00 in summer, 00:00 in winter).
 */
export const NIGHTLY_FIXTURE_RUN_UTC_HOUR = 0;

/** The next run strictly after `now`. */
export function nextNightlyFixtureRun(now: Date): Date {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_FIXTURE_RUN_UTC_HOUR),
  );
  return today.getTime() > now.getTime() ? today : new Date(today.getTime() + 24 * 60 * 60 * 1000);
}
