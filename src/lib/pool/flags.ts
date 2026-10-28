/**
 * THE POOL'S SWITCHES (slice L1, 2026-10-24; the platform switch moved to
 * the database 2026-10-28). PURE.
 *
 * Decision log #2: every pool feature ships behind a per-club flag that is
 * OFF, and one platform switch.
 *
 *   The PLATFORM switch   the master ("kill") switch (plan section 4.4).
 *                         Since 2026-10-28 (decision log P.1) a database
 *                         row, `PlatformSetting` "pool-offers", flipped by
 *                         the platform owner on /admin/clubs, so it takes
 *                         effect on the next request or poll with no
 *                         redeploy. Read per request and per poll, never
 *                         cached (`platform-switch.ts`). No row: OFF.
 *   POOL_OFFERS_ENABLED   now only an EMERGENCY OVERRIDE that can force the
 *                         pool OFF ("0", "false", "off", "no"); any other
 *                         value, or none, leaves the database row in
 *                         charge. It can never force the pool on.
 *   Organisation.featurePlayerPool   the club's own switch, set by the
 *                         club's owners and admins on /admin/settings.
 *   Organisation.poolAutoAsk         the club's automatic ask includes the
 *                                    pool (L9).
 *
 * THE ONE RULE: the pool is open for a club when the platform switch AND
 * the club's flag are on (`poolOpenForClub`). Every reader uses it.
 *
 * HOW THE SWITCH TRAVELS. The pool's functions take an `env` (as they did
 * when the switch was an environment variable). A request resolves the
 * platform switch once (`switch-env.ts`) and carries the answer in that
 * env under `POOL_OPEN_KEY`. `isPoolOffersEnabled` reads ONLY that key, so
 * a path that forgot to resolve the switch (plain `process.env`) reads
 * the pool as CLOSED: it fails safe.
 *
 *   POOL_SIGNUP_PAUSED    (slice L2) the brake on the /play sign-up and
 *                         its WhatsApp confirmation: sign-up is OPEN unless
 *                         this is explicitly on.
 *
 * While the pool is not open, a sign-up goes on the early sign-up list
 * (`signupGoesOnEarlyList`).
 *
 * TEST SEAM (`poolOpenFrom`, the `self-join-flag.ts` pattern): a cookie or
 * header may say the pool is open or not, honoured only when the server was
 * booted with MT_TEST_MODE exactly "1" (`flags-request.ts` reads it).
 */

/** The emergency override: can only force the pool OFF. */
export const POOL_OFFERS_ENV = "POOL_OFFERS_ENABLED";
/** The resolved platform switch, carried in a call's env ("1" open). */
export const POOL_OPEN_KEY = "MT_POOL_OPEN";
/** Set when the switch could not be read this request (a database error):
 *  the pool reads CLOSED for sending, but the sweep must not take that as
 *  the owner switching it off and close every open ask. */
export const POOL_SWITCH_UNREAD_KEY = "MT_POOL_SWITCH_UNREAD";

type Env = Record<string, string | undefined>;

/** Does the environment force the pool off (the emergency override)? */
export function poolForcedOffByEnv(env: Env = process.env): boolean {
  return /^(0|false|off|no)$/i.test((env[POOL_OFFERS_ENV] ?? "").trim());
}

/** The platform switch: the database row, unless the env forces it off. */
export function poolPlatformOpen(rowOn: boolean, env: Env = process.env): boolean {
  return rowOn === true && !poolForcedOffByEnv(env);
}

/** The platform switch, as resolved for this call (`switch-env.ts`). */
export function isPoolOffersEnabled(env: Env = process.env): boolean {
  return env[POOL_OPEN_KEY] === "1";
}

/** Was the switch unreadable for this call (`POOL_SWITCH_UNREAD_KEY`)? */
export function poolSwitchUnread(env: Env = process.env): boolean {
  return env[POOL_SWITCH_UNREAD_KEY] === "1";
}

/** An env carrying the resolved platform switch. */
export function poolSwitchEnv(open: boolean, env: Env = {}): Env {
  return { ...env, [POOL_OPEN_KEY]: open ? "1" : "0" };
}

/** THE ONE RULE: may this club use the pool? The platform switch AND the
 *  club's own flag. */
export function poolOpenForClub(org: { featurePlayerPool: boolean } | null | undefined, platformOpen: boolean): boolean {
  return org?.featurePlayerPool === true && platformOpen === true;
}

/** The one rule, with the platform switch as this call resolved it. */
export function poolOffersOpenForClub(
  org: { featurePlayerPool: boolean } | null | undefined,
  env: Env = process.env,
): boolean {
  return poolOpenForClub(org, isPoolOffersEnabled(env));
}

export const POOL_SIGNUP_PAUSED_ENV = "POOL_SIGNUP_PAUSED";

/** Is the /play sign-up (and its WhatsApp confirmation) braked? */
export function isPoolSignupPaused(env: Env = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env[POOL_SIGNUP_PAUSED_ENV] ?? "").trim());
}

/** A sign-up made now goes on the early sign-up list: the pool is not open. */
export function signupGoesOnEarlyList(env: Env = process.env): boolean {
  return !isPoolOffersEnabled(env);
}

/** The same with a page's or request's test override ("1" / "0", honoured
 *  only under MT_TEST_MODE=1) and the platform switch as read. */
export function signupGoesOnEarlyListFrom(override: string | undefined, platformOpen: boolean, env: Env = process.env): boolean {
  return !poolOpenFrom(override, platformOpen, env);
}

/** Is the pool open, given a test override ("1" / "0") and the platform
 *  switch as read? The override counts only under MT_TEST_MODE=1. */
export function poolOpenFrom(override: string | undefined, platformOpen: boolean, env: Env = process.env): boolean {
  if (env.MT_TEST_MODE === "1") {
    if (override === "1") return true;
    if (override === "0") return false;
  }
  return platformOpen === true;
}
