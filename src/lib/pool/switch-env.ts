/**
 * THE POOL SWITCH, AS AN ENVIRONMENT FOR THE CALL (slice L5a; the platform
 * switch read from the database since 2026-10-28). The pool's functions
 * take an `env` and read the resolved switch from it (`flags.ts`
 * `isPoolOffersEnabled`). A request resolves it HERE, once: the test seam
 * (`flags-request.ts`, honoured only under MT_TEST_MODE=1), else the
 * platform row (`platform-switch.ts`, read now, never cached), so one
 * switch decides everywhere: the platform poll, due-posts, HQ, DMs, the
 * match page, the club settings cards and the offer page.
 *
 * A database error reading the row: the pool is CLOSED for this request
 * (nothing is offered or sent), marked unread so the sweep does not close
 * every open ask as if the owner had switched it off.
 */
import { cookies, headers } from "next/headers";
import { POOL_SWITCH_UNREAD_KEY, poolSwitchEnv } from "./flags";
import { POOL_OPEN_TEST_COOKIE, POOL_OPEN_TEST_HEADER, poolTestOverrideOf } from "./flags-request";
import { poolPlatformOpenNow } from "./platform-switch";

type Env = Record<string, string | undefined>;

/** Resolve the switch for a call: the test override, else the platform row. */
export async function resolvePoolEnv(override: string | undefined, env: Env = process.env): Promise<Env> {
  if (env.MT_TEST_MODE === "1" && (override === "1" || override === "0")) return poolSwitchEnv(override === "1", env);
  const open = await poolPlatformOpenNow(env);
  if (open === null) return { ...poolSwitchEnv(false, env), [POOL_SWITCH_UNREAD_KEY]: "1" };
  return poolSwitchEnv(open, env);
}

/** For the Pi's API routes (a header) and any route with a cookie. */
export async function poolEnvForApiRequest(request: Request, env: Env = process.env): Promise<Env> {
  return resolvePoolEnv(poolTestOverrideOf(request, env), env);
}

/**
 * For server components and server actions (the cookie, or the header).
 * Reads the request EVERY time, test mode or not, so a page that asks is
 * rendered per request and follows the switch at run time (never frozen
 * into a static build, and never reading the database at build time).
 */
export async function poolEnvForRequest(env: Env = process.env): Promise<Env> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  const override = env.MT_TEST_MODE === "1" ? (h.get(POOL_OPEN_TEST_HEADER) ?? c.get(POOL_OPEN_TEST_COOKIE)?.value) : undefined;
  return resolvePoolEnv(override, env);
}
