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
 * A per-request test override (the `self-join-flag.ts` pattern) is added
 * by the first slice whose routes read the switch.
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
