/**
 * SETUP_LEARNING_ENABLED as the WEBSITE reads it (go-live slice S5): the
 * Go live button must say "still reading" under the same rule as the GO
 * DM, which reads the flag per request (`setupLearningEnabledForRequest`,
 * setup-learning/flag.ts).
 *
 * TEST SEAM, the same double gate as billing-flag.ts: the cookie
 * `mt-test-setup-learning` may say "1" or "0", honoured only when the
 * server was booted with MT_TEST_MODE exactly "1". Production reads the
 * environment and nothing else.
 */
import { cookies } from "next/headers";
import { isSetupLearningEnabled } from "./setup-learning/flag";

export const SETUP_LEARNING_TEST_COOKIE = "mt-test-setup-learning";

export function setupLearningUiEnabledFrom(
  cookieValue: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MT_TEST_MODE === "1") {
    if (cookieValue === "1") return true;
    if (cookieValue === "0") return false;
  }
  return isSetupLearningEnabled(env);
}

export async function setupLearningUiEnabledForRequest(): Promise<boolean> {
  let value: string | undefined;
  if (process.env.MT_TEST_MODE === "1") {
    value = (await cookies()).get(SETUP_LEARNING_TEST_COOKIE)?.value;
  }
  return setupLearningUiEnabledFrom(value);
}
