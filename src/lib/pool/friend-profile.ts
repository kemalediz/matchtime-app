/**
 * The pool's facts a friend link needs (2026-10-31), read here so the
 * pool's tables stay read by the pool's own code (`source-guard.test.ts`):
 * his language and display name, whether this club blocked him, and the
 * activity stamp a booking leaves.
 */
import { db } from "../db";

export async function friendPoolFacts(userId: string, orgId: string): Promise<{ language: string | null; displayName: string | null; blockedByClub: boolean }> {
  const [profile, block] = await Promise.all([
    db.poolProfile.findUnique({ where: { userId }, select: { language: true, displayName: true } }),
    db.poolBlock.findFirst({ where: { orgId, userId, by: "club" }, select: { id: true } }),
  ]);
  return { language: profile?.language ?? null, displayName: profile?.displayName ?? null, blockedByClub: !!block };
}

export async function markPoolActive(userId: string, now: Date): Promise<void> {
  await db.poolProfile.updateMany({ where: { userId }, data: { lastActiveAt: now } });
}
