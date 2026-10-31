/**
 * THE /play REMINDER'S STATUS CHECK, the thin I/O half (2026-10-31) of
 * `signup-status-rules.ts`. SERVER ONLY.
 *
 * Capped first, per requesting address (rules.ts POOL_SIGNUP_STATUS), every
 * check counted whatever its answer. Then the token (`signup-status-token.ts`):
 * one we did not sign for this code is "gone" with no database read, so a
 * guesser learns nothing. Only then the one row, three columns.
 *
 * The cap lives in this server instance's memory: best effort across
 * instances, and enough, because the token is what keeps guessers out. A
 * request with no address shares one bucket, so it is capped too.
 */
import { db } from "../db";
import { POOL_SIGNUP_STATUS } from "./rules";
import { poolSignupState, takeStatusCheck, type PoolSignupState } from "./signup-status-rules";
import { readPoolSignupStatusToken } from "./signup-status-token";

const buckets = new Map<string, number[]>();
/** Enough addresses for any real hour; past it the oldest is dropped. */
const MAX_BUCKETS = 10_000;

/** Tests only: forget every count. */
export function resetPoolSignupStatusLimiter(): void {
  buckets.clear();
}

function allow(ip: string | null, nowMs: number): boolean {
  const key = ip ?? "no-address";
  const r = takeStatusCheck(buckets.get(key) ?? [], nowMs, POOL_SIGNUP_STATUS.perIpPerHour);
  buckets.delete(key);
  buckets.set(key, r.hits);
  if (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value as string);
  return r.ok;
}

export async function checkPoolSignupStatus(args: {
  token: unknown;
  code: unknown;
  ip: string | null;
  now?: Date;
}): Promise<{ ok: true; state: PoolSignupState } | { ok: false; reason: "busy" }> {
  const now = args.now ?? new Date();
  if (!allow(args.ip, now.getTime())) return { ok: false, reason: "busy" };
  const id = readPoolSignupStatusToken(args.token, args.code);
  if (!id) return { ok: true, state: "gone" };
  const row = await db.poolProfile.findUnique({
    where: { id },
    select: { status: true, confirmCode: true, confirmCodeExpiresAt: true },
  });
  return { ok: true, state: poolSignupState(row, args.code as string, now) };
}
