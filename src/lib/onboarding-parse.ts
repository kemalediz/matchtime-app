/**
 * What survives of the legacy in-group setup (OnboardingSession), deleted
 * on 2026-10-30. Its parsers (consent, admins, day, time, venue, cancel)
 * are gone. Left: the session stage list and TTL, which the orgs route
 * and admin-group-link.ts still read, and the ONBOARDING_AUTOSTART gate
 * of the bot-added route.
 */

// ─────────────────────────── session lifecycle ─────────────────────────

/** The stages during which a legacy session owned its group. Read by the
 *  orgs route and admin-group-link.ts. */
export const ACTIVE_ONBOARDING_STAGES = [
  "introduced",
  "admins",
  "details",
  "collecting",
  "features",
] as const;

/** A session older than this (from creation) is stale. Read by the orgs
 *  route. */
export const ONBOARDING_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// ───────────────────────── env-flag gate ────────────────────────────────

/**
 * The bot-added route's gate while self-join is off. OFF unless the env
 * var is explicitly "1", "true", "on" or "yes".
 */
export function isOnboardingAutostartEnabled(
  value: string | undefined = process.env.ONBOARDING_AUTOSTART,
): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}
