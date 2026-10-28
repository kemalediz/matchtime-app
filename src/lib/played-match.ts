/**
 * A CANCELLED MATCH IS NEVER PLAYED (2026-10-28).
 *
 * A match that kicked off can now be cancelled ("this game didn't happen",
 * `match-cancel.ts`). Its Attendance, Rating and MoMVote rows stay where
 * they are, so putting the game back brings them back; every reader that
 * counts them as played excludes the cancelled match instead, with this
 * one filter spread into its `match` clause:
 *
 *   db.rating.findMany({ where: { playerId, match: { activity: { orgId }, ...NOT_CANCELLED } } })
 *
 * Readers that already require `status: "COMPLETED"` need nothing more.
 * `__tests__/played-match.test.ts` finds every club-wide Rating and MoMVote
 * read in the code and fails when one has neither.
 */
export const NOT_CANCELLED = { status: { not: "CANCELLED" } } as const;
