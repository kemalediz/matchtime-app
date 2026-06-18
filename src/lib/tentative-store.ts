/**
 * DB side of the tentative-availability follow-up feature.
 *
 * Thin, idempotent wrappers around the TentativeAvailability table so the
 * analyze route, the DM-reply path, and the attendance lib can all share
 * one source of truth for "record a maybe" and "resolve a maybe". The
 * pure scheduling/guard decisions live in tentative-followup.ts; this
 * module only does persistence.
 */
import { db } from "@/lib/db";
import { computeFollowupDueAt } from "@/lib/tentative-followup";

/**
 * Record a player as a MAYBE for a match and schedule their follow-up.
 *
 * Idempotent on (matchId, userId): if an UNRESOLVED row already exists we
 * leave it untouched (don't reschedule, don't duplicate). If the only
 * existing row is already resolved, we leave it — a player who already
 * gave a firm answer shouldn't be re-chased just because they later said
 * something ambiguous again (prefer NOT spamming).
 *
 * @returns the row id when freshly recorded, or null when a row already
 *          existed (so callers can avoid a redundant reply).
 */
export async function recordTentative(args: {
  matchId: string;
  userId: string;
  kickoff: Date;
  now?: Date;
}): Promise<string | null> {
  const { matchId, userId, kickoff } = args;
  const now = args.now ?? new Date();

  const existing = await db.tentativeAvailability.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  if (existing) return null; // already a maybe (resolved or not) — don't touch

  const dueAt = computeFollowupDueAt(kickoff, now);
  const created = await db.tentativeAvailability.create({
    data: { matchId, userId, dueAt },
  });
  return created.id;
}

/**
 * Resolve a player's tentative record for a match (they gave a firm
 * IN/OUT, or the follow-up guard found the question moot). Idempotent and
 * best-effort: no-ops when there's no unresolved row.
 */
export async function resolveTentative(args: {
  matchId: string;
  userId: string;
  now?: Date;
}): Promise<void> {
  const { matchId, userId } = args;
  const now = args.now ?? new Date();
  await db.tentativeAvailability
    .updateMany({
      where: { matchId, userId, resolvedAt: null },
      data: { resolvedAt: now },
    })
    .catch(() => {});
}
