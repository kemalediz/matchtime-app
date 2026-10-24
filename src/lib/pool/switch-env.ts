/**
 * THE POOL SWITCH, AS AN ENVIRONMENT FOR THE CALL (slice L5a). The pool's
 * functions take an `env` and read POOL_OFFERS_ENABLED from it
 * (`flags.ts`); a request turns its test seam (`flags-request.ts`, honoured
 * only under MT_TEST_MODE=1) into that env here, so one switch decides
 * everywhere: the platform poll, due-posts, the match page and the offer
 * page. Outside test mode this is exactly `process.env`.
 */
import { cookies } from "next/headers";
import { POOL_OFFERS_ENV, poolOpenFrom } from "./flags";
import { POOL_OPEN_TEST_COOKIE, poolOpenForApiRequest } from "./flags-request";

type Env = Record<string, string | undefined>;

export function envWithPoolSwitch(open: boolean, env: Env = process.env): Env {
  return { ...env, [POOL_OFFERS_ENV]: open ? "1" : "0" };
}

/** For the Pi's API routes (a header) and any route with a cookie. */
export function poolEnvForApiRequest(request: Request, env: Env = process.env): Env {
  return envWithPoolSwitch(poolOpenForApiRequest(request, env), env);
}

/** For server components and server actions (the cookie). */
export async function poolEnvForRequest(env: Env = process.env): Promise<Env> {
  const value = env.MT_TEST_MODE === "1" ? (await cookies()).get(POOL_OPEN_TEST_COOKIE)?.value : undefined;
  return envWithPoolSwitch(poolOpenFrom(value, env), env);
}
