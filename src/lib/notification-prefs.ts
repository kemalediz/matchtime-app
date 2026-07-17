import { db } from "@/lib/db";
import type { DmSubPatch } from "@/lib/dm-subscriptions";

/**
 * Per-category proactive-DM subscription preferences (writer).
 *
 * Flips any subset of the `sub*` flags for ALL of a user's active
 * (non-left) memberships — a preference is about the human, not one club.
 * All categories default to true (subscribed); a player unsubscribes via
 * the DM keyword fast-path in `/api/whatsapp/dm-reply` (parser lives in
 * `src/lib/dm-subscriptions.ts`).
 *
 * PAYMENT DMs have no flag and are never affected by this — a player who
 * owes money is always messaged their pay link + chases.
 *
 * Returns the Prisma `updateMany` batch result so callers can assert the
 * write actually landed before acking the player ("never tell someone they
 * won't be messaged unless the write succeeded").
 */
export async function setDmSubscriptions(userId: string, patch: DmSubPatch) {
  return db.membership.updateMany({
    where: { userId, leftAt: null },
    data: { ...patch, subPrefsUpdatedAt: new Date() },
  });
}

/**
 * @deprecated Thin shim over {@link setDmSubscriptions}. The old
 * single rating toggle is now the `subRatingDm` category
 * (`subRatingDm = !optOut`). Kept so any external caller keeps working;
 * new code should call setDmSubscriptions directly. Does NOT touch the
 * deprecated `ratingDmOptOut` column any more.
 */
export async function setRatingDmOptOut(userId: string, optOut: boolean) {
  return setDmSubscriptions(userId, { subRatingDm: !optOut });
}
