/**
 * THE POOL'S SWITCHES (slice L1, 2026-10-24). PURE.
 *
 * Decision log #2: every pool feature ships behind a per-club flag that is
 * OFF, and one global switch, also OFF, so shipping a slice never changes a
 * live club.
 *
 *   POOL_OFFERS_ENABLED   the master switch (plan section 4.4, "kill
 *                         switch"): off unless explicitly "1", "true", "on"
 *                         or "yes". Checked at queue time AND at dispatch
 *                         by the slices that send offers (L5), as
 *                         SELF_JOIN_ENABLED is. An environment variable, as
 *                         every platform switch here is; there is no
 *                         database settings table.
 *   Organisation.featurePlayerPool   the club may ask the pool.
 *   Organisation.poolAutoAsk         the club's automatic ask includes the
 *                                    pool (L9).
 *
 *   POOL_SIGNUP_PAUSED    (slice L2) the brake on the /play sign-up and
 *                         its WhatsApp confirmation: sign-up is OPEN unless
 *                         this is explicitly on. Sign-up changes no club and
 *                         sends nothing first, and while the pool is not
 *                         open it fills the early sign-up list (G0), so it
 *                         is on by default; the brake is for abuse.
 *
 * While the pool is not open (POOL_OFFERS_ENABLED off), a sign-up goes on
 * the early sign-up list (`signupGoesOnEarlyList`). Per town later (D-6).
 *
 * TEST SEAM (`poolOpenFrom`, the `self-join-flag.ts` pattern): a cookie or
 * header may say the pool is open or not, honoured only when the server was
 * booted with MT_TEST_MODE exactly "1" (`flags-request.ts` reads it).
 */

export const POOL_OFFERS_ENV = "POOL_OFFERS_ENABLED";

type Env = Record<string, string | undefined>;

export function isPoolOffersEnabled(env: Env = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env[POOL_OFFERS_ENV] ?? "").trim());
}

/** May this club's matches be offered to the pool at all? */
export function poolOffersOpenForClub(
  org: { featurePlayerPool: boolean } | null | undefined,
  env: Env = process.env,
): boolean {
  return org?.featurePlayerPool === true && isPoolOffersEnabled(env);
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

/** The same switch with a page's or request's test override ("1" / "0",
 *  honoured only under MT_TEST_MODE=1): what the sign-up route stamps on
 *  a profile, and so what every page may tell a visitor. */
export function signupGoesOnEarlyListFrom(override: string | undefined, env: Env = process.env): boolean {
  return override === undefined ? signupGoesOnEarlyList(env) : !poolOpenFrom(override, env);
}

/** Is the pool open, given a test override ("1" / "0") and the environment?
 *  The override counts only under MT_TEST_MODE=1. */
export function poolOpenFrom(override: string | undefined, env: Env = process.env): boolean {
  if (env.MT_TEST_MODE === "1") {
    if (override === "1") return true;
    if (override === "0") return false;
  }
  return isPoolOffersEnabled(env);
}
