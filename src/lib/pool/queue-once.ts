/**
 * A platform DM queued at most once per refId (the /play confirm's welcome,
 * code replies and claims; the friend link's DMs), under a lock on the
 * refId, inside the caller's transaction when given one. False, and
 * logged, when the platform channel refuses it; never thrown.
 */
import { db } from "../db";
import { PlatformDmRefused, queuePlatformDm, type PlatformDmPurpose } from "../platform-jobs";

export type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** Queue a DM unless one with this refId exists, under a lock on the refId.
 *  Also the friend link's (`friend-link/book.ts`). */
export async function queueOnce(phone: string, text: string, purpose: PlatformDmPurpose, refId: string): Promise<boolean> {
  return db.$transaction(async (tx: Tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${refId}))`;
    if (await tx.platformJob.findFirst({ where: { purpose, refId }, select: { id: true } })) return false;
    return queue(phone, text, purpose, refId, tx);
  });
}

/** False, and logged, when the platform channel refuses it; never thrown at the DM route. */
export async function queue(phone: string, text: string, purpose: PlatformDmPurpose, refId: string, tx: Tx): Promise<boolean> {
  try {
    await queuePlatformDm({ phone, text, purpose, refId, client: tx as never });
    return true;
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[pool-confirm] ${purpose} not queued: ${err.code}`);
      return false;
    }
    throw err;
  }
}

