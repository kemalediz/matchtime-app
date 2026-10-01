/**
 * BILLING_ENABLED, as the organiser WEB reads it (club fee billing, slice
 * B2): the billing page, the /admin/settings billing card and the banner.
 *
 * In production this is exactly `isBillingEnabled()` (club-billing-rules.ts):
 * the env var, off unless explicitly on. Off, nothing about billing is
 * visible to any organiser (plan section 11, rollout step 1).
 *
 * TEST SEAM, the same double gate as `self-join-flag.ts`: the e2e suite
 * runs ONE dev server with BILLING_ENABLED on, and must also show that
 * nothing appears with it off. A cookie may override the flag for the
 * web only, and only when the server was booted with `MT_TEST_MODE`
 * exactly "1", which nothing sets but `e2e/helpers/env.ts`. Outside test
 * mode the cookie is ignored in both directions. The quiet gates, the
 * trial at approval and every server-side rule read the env var alone.
 */
import { cookies } from "next/headers";
import { isBillingEnabled } from "./club-billing-rules";

export const BILLING_TEST_COOKIE = "mt-test-billing";

/** Pure: the web's flag from a cookie value and an environment. */
export function billingUiEnabledFrom(
  cookieValue: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    if (cookieValue === "1") return true;
    if (cookieValue === "0") return false;
  }
  return isBillingEnabled(env);
}

/** For server components, route handlers and server actions. */
export async function billingUiEnabledForRequest(): Promise<boolean> {
  let value: string | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    value = (await cookies()).get(BILLING_TEST_COOKIE)?.value;
  }
  return billingUiEnabledFrom(value);
}
