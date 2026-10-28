/**
 * THE PLAYER POOL'S PLATFORM SWITCH, the database half (2026-10-28,
 * decision log P.1). Kemal: "The owner is just a kill switch... enable it
 * for all the clubs or kill it for all the clubs".
 *
 * One `PlatformSetting` row, key "pool-offers". The platform owner flips it
 * on /admin/clubs (`app/actions/pool-platform-switch.ts`). Read on EVERY
 * request and every Pi poll (`switch-env.ts`), never cached, so OFF takes
 * effect on the next poll. No row: OFF. POOL_OFFERS_ENABLED can still force
 * it off in an emergency (`flags.ts` `poolPlatformOpen`).
 *
 * OFF: the row is written first, so no new ask or offer can start, then
 * every open pool ask of every club is closed at once through the pool's
 * own close path (`round.ts` `closePoolAsk`, reason "switched-off"): their
 * open offers end and unsent offer DMs are cancelled. The sweep and
 * dispatch would do the same on the next poll; closing here leaves nothing
 * half open between. Nobody is messaged. Every club's own flag
 * (`featurePlayerPool`, `poolAutoAsk`) is left as it is, so ON again
 * restores each club's own choice.
 */
import { db } from "../db";
import { poolPlatformOpen, poolForcedOffByEnv } from "./flags";

export const POOL_PLATFORM_KEY = "pool-offers";

type Env = Record<string, string | undefined>;

/** The row as stored (no row: off). Throws on a database error. */
export async function readPoolPlatformRow(): Promise<{ on: boolean; updatedAt: Date | null; updatedById: string | null }> {
  const row = await db.platformSetting.findUnique({ where: { key: POOL_PLATFORM_KEY }, select: { on: true, updatedAt: true, updatedById: true } });
  return { on: row?.on === true, updatedAt: row?.updatedAt ?? null, updatedById: row?.updatedById ?? null };
}

/**
 * Is the pool open on the platform right now? Null when the row could not
 * be read (a database error, logged): the caller treats the pool as closed
 * for sending, and the sweep does not close asks on it (`switch-env.ts`).
 */
export async function poolPlatformOpenNow(env: Env = process.env): Promise<boolean | null> {
  try {
    const row = await readPoolPlatformRow();
    return poolPlatformOpen(row.on, env);
  } catch (err) {
    console.error(`[pool] the platform switch could not be read; the pool is treated as closed for this request: ${(err as Error)?.message ?? "error"}`);
    return null;
  }
}

/** What the owner page shows. */
export async function loadPoolPlatformSwitch(env: Env = process.env): Promise<{ on: boolean; forcedOff: boolean; updatedAt: Date | null }> {
  const row = await readPoolPlatformRow();
  return { on: row.on, forcedOff: poolForcedOffByEnv(env), updatedAt: row.updatedAt };
}

export interface PoolPlatformSwitchResult {
  on: boolean;
  closedAsks: number;
  /** The env override forces the pool off whatever the row says. */
  forcedOff: boolean;
}

export async function setPoolPlatformSwitch(on: boolean, byUserId: string, now: Date = new Date(), env: Env = process.env): Promise<PoolPlatformSwitchResult> {
  await db.platformSetting.upsert({
    where: { key: POOL_PLATFORM_KEY },
    create: { key: POOL_PLATFORM_KEY, on, updatedById: byUserId },
    update: { on, updatedById: byUserId },
  });
  const forcedOff = poolForcedOffByEnv(env);
  if (on) return { on, closedAsks: 0, forcedOff };

  // Loaded here only: the readers above are on every page and poll, and
  // must not pull the pool's whole send path in with them.
  const { closePoolAsk } = await import("./round");
  const open = await db.poolAsk.findMany({ where: { status: "open" }, select: { id: true } });
  let closedAsks = 0;
  for (const a of open) if (await closePoolAsk(a.id, "switched-off", now)) closedAsks++;
  console.log(`[pool] the player pool was switched off for every club by ${byUserId}: ${closedAsks} open ask(s) closed`);
  return { on, closedAsks, forcedOff };
}
