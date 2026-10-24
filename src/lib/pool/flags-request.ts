/**
 * The pool's switches as a request reads them (slice L2): the test seam of
 * `flags.ts` (`poolOpenFrom`), read off the request's cookie or header.
 * Outside MT_TEST_MODE=1 both are ignored and this is exactly the
 * environment variable.
 */
import { poolOpenFrom } from "./flags";

export const POOL_OPEN_TEST_COOKIE = "mt-test-pool-open";
export const POOL_OPEN_TEST_HEADER = "x-mt-test-pool-open";

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Is the pool open, for this API request (the /play sign-up route)? */
export function poolOpenForApiRequest(request: Request, env: Record<string, string | undefined> = process.env): boolean {
  const override = request.headers.get(POOL_OPEN_TEST_HEADER) ?? cookieValue(request.headers.get("cookie"), POOL_OPEN_TEST_COOKIE);
  return poolOpenFrom(override ?? undefined, env);
}
