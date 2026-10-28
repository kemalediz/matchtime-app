/**
 * The pool's switches as a request reads them (slice L2): the test seam of
 * `flags.ts` (`poolOpenFrom`), read off the request's cookie or header.
 * Outside MT_TEST_MODE=1 both are ignored and the answer is the platform
 * switch (`platform-switch.ts`, the database row, since 2026-10-28).
 */
import { isPoolOffersEnabled } from "./flags";

export const POOL_OPEN_TEST_COOKIE = "mt-test-pool-open";
export const POOL_OPEN_TEST_HEADER = "x-mt-test-pool-open";

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** The test override on this request ("1" / "0"), honoured only under
 *  MT_TEST_MODE=1; undefined otherwise. */
export function poolTestOverrideOf(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.MT_TEST_MODE !== "1") return undefined;
  return request.headers.get(POOL_OPEN_TEST_HEADER) ?? cookieValue(request.headers.get("cookie"), POOL_OPEN_TEST_COOKIE) ?? undefined;
}

/** Is the pool open, for this API request (the /play sign-up route)? */
export async function poolOpenForApiRequest(request: Request, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const { poolEnvForApiRequest } = await import("./switch-env");
  return isPoolOffersEnabled(await poolEnvForApiRequest(request, env));
}
