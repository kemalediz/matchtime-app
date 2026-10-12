/**
 * SETUP_HOLD_ENABLED, as a request reads it (go-live plan, slice S1).
 *
 * In production this is exactly `isSetupHoldEnabled()`
 * (club-setup-rules.ts): the env var, off unless explicitly on. On, an
 * approval leaves the club "setting up" (approved, silent) until its
 * organiser says GO. Off, an approval is byte for byte today's.
 *
 * Nothing in slice S1 reads the flag: the silence rails are keyed on the
 * club's stored stage, so a club already setting up stays silent whatever
 * the flag says. Slices S3 to S5 read it at the approval, in the DM route
 * and on the settings page.
 *
 * TEST SEAM, the same double gate as self-join-flag.ts. The e2e suite has
 * to show the held approval with the flag ON and today's approval with it
 * OFF, from ONE dev server. A cookie (organiser web) or a header (the Pi's
 * API routes, the crons) may therefore override the flag, but only when
 * the server was booted with `MT_TEST_MODE` exactly "1", which nothing
 * sets but `e2e/helpers/env.ts`. Outside test mode both are ignored in
 * both directions.
 */
import { cookies } from "next/headers";
import { isSetupHoldEnabled } from "./club-setup-rules";

export const SETUP_HOLD_TEST_COOKIE = "mt-test-setup-hold";
export const SETUP_HOLD_TEST_HEADER = "x-mt-test-setup-hold";

/** Pure: the flag from an override value and an environment. */
export function setupHoldEnabledFrom(
  override: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    if (override === "1") return true;
    if (override === "0") return false;
  }
  return isSetupHoldEnabled(env);
}

/** For server components and server actions. */
export async function setupHoldEnabledForRequest(): Promise<boolean> {
  let value: string | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    value = (await cookies()).get(SETUP_HOLD_TEST_COOKIE)?.value;
  }
  return setupHoldEnabledFrom(value);
}

/** For the Pi's API routes and the crons, which carry no cookie. */
export function setupHoldEnabledForApiRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return setupHoldEnabledFrom(request.headers.get(SETUP_HOLD_TEST_HEADER) ?? undefined, env);
}
