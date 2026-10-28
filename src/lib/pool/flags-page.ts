/**
 * The pool's switch as a SERVER PAGE or action reads it: will a sign-up
 * made now go on the early sign-up list? The same answer the /play sign-up
 * route stamps on the profile (`flags-request.ts`), with the same test seam
 * (cookie or header, honoured only under MT_TEST_MODE=1), so no page tells
 * a visitor about the early list unless that is what will happen.
 */
import { signupGoesOnEarlyList } from "./flags";
import { poolEnvForRequest } from "./switch-env";

/**
 * Reads the request (and the platform switch) every time, so a page that
 * asks is rendered per request and follows the switch at run time (never
 * frozen into a static build).
 */
export async function signupGoesOnEarlyListForPage(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return signupGoesOnEarlyList(await poolEnvForRequest(env));
}
