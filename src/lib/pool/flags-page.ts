/**
 * The pool's switch as a SERVER PAGE or action reads it: will a sign-up
 * made now go on the early sign-up list? The same answer the /play sign-up
 * route stamps on the profile (`flags-request.ts`), with the same test seam
 * (cookie or header, honoured only under MT_TEST_MODE=1), so no page tells
 * a visitor about the early list unless that is what will happen.
 */
import { cookies, headers } from "next/headers";
import { signupGoesOnEarlyListFrom } from "./flags";
import { POOL_OPEN_TEST_COOKIE, POOL_OPEN_TEST_HEADER } from "./flags-request";

/**
 * Reads the request every time, so a page that asks is rendered per
 * request and follows the switch at run time (never frozen into a static
 * build). The override itself counts only under MT_TEST_MODE=1.
 */
export async function signupGoesOnEarlyListForPage(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  const override = env.MT_TEST_MODE === "1" ? (h.get(POOL_OPEN_TEST_HEADER) ?? c.get(POOL_OPEN_TEST_COOKIE)?.value) : undefined;
  return signupGoesOnEarlyListFrom(override ?? undefined, env);
}
