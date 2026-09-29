/**
 * SELF_JOIN_ENABLED, as the organiser web reads it (slice 4).
 *
 * In production this is exactly `isSelfJoinEnabled()` (club-approval.ts):
 * the env var, off unless explicitly on.
 *
 * TEST SEAM. The e2e suite has to show the organiser flow with the flag
 * ON and today's create-org with it OFF, from ONE dev server. A cookie
 * may therefore override the flag, but only when the server was booted
 * with `MT_TEST_MODE` exactly "1", which nothing sets but
 * `e2e/helpers/env.ts` (the same double gate as `x-test-now` in
 * due-posts and `x-mt-engine-routes` in route-flags.ts). Outside test
 * mode the cookie is ignored in both directions.
 */
import { cookies } from "next/headers";
import { isSelfJoinEnabled } from "./club-approval";

export const SELF_JOIN_TEST_COOKIE = "mt-test-self-join";

/** Pure: the flag from a cookie value and an environment. */
export function selfJoinEnabledFrom(
  cookieValue: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    if (cookieValue === "1") return true;
    if (cookieValue === "0") return false;
  }
  return isSelfJoinEnabled(env.SELF_JOIN_ENABLED);
}

/** For server components and server actions. */
export async function selfJoinEnabledForRequest(): Promise<boolean> {
  let value: string | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    value = (await cookies()).get(SELF_JOIN_TEST_COOKIE)?.value;
  }
  return selfJoinEnabledFrom(value);
}
