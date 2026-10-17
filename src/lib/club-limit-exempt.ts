/**
 * Clubs exempt from the new-club member DM cap (`newClubDmCap`,
 * club-decision-rules.ts), Kemal, 2026-10-16.
 *
 * Until quiet hours became a club setting (2026-10-16) this also lifted
 * the admin-group posting hours for the listed clubs. That part is gone:
 * a club's quiet hours are now its own choice on /admin/settings
 * (`quietHoursOf`, message-hours.ts), and the manager sets them with
 * `scripts/set-quiet-hours.ts`.
 *
 * Driven by ONE env var, `CLUB_LIMIT_EXEMPT_ORG_IDS`: org ids separated by
 * commas and/or whitespace. Unset or empty means no club is exempt, and
 * the cap behaves exactly as before.
 */

export const CLUB_LIMIT_EXEMPT_ENV = "CLUB_LIMIT_EXEMPT_ORG_IDS";

/** The exempt org ids, parsed from the raw env value. */
export function parseClubLimitExemptIds(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** True when this org is listed in `CLUB_LIMIT_EXEMPT_ORG_IDS`. Read on every call, so tests and env changes apply at once. */
export function isClubLimitExempt(orgId: string | null | undefined): boolean {
  if (!orgId) return false;
  return parseClubLimitExemptIds(process.env[CLUB_LIMIT_EXEMPT_ENV]).has(orgId);
}
