import { db } from "@/lib/db";

/**
 * Per-club opt-out for rating + Man-of-the-Match DMs.
 *
 * Flips `Membership.ratingDmOptOut` for ALL of a user's active (non-left)
 * memberships. Scope is deliberately narrow — see the schema comment on
 * `Membership.ratingDmOptOut`: it suppresses ONLY the post-match rating DM
 * and the daily rating-reminder DM, never match invites, payment chases,
 * or answers to questions the player initiates.
 *
 * Returns the Prisma `updateMany` batch result so callers can assert the
 * write actually landed before acking the player ("never tell someone they
 * won't be messaged unless the write succeeded").
 */
export async function setRatingDmOptOut(userId: string, optOut: boolean) {
  return db.membership.updateMany({
    where: { userId, leftAt: null },
    data: { ratingDmOptOut: optOut, ratingDmOptOutAt: optOut ? new Date() : null },
  });
}
