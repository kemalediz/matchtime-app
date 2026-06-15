/**
 * Authorisation logic for "promote from bench" actions driven by chat.
 *
 * When a registerFor pair drops a confirmed player (OUT) and brings a
 * bench player up to fill the freed slot (IN) — e.g. "replace Ehtisham
 * with Aydın" — the IN must pass `promoteFromBench: true` to
 * registerAttendance so the bench player is moved straight into the
 * squad WITHOUT the usual 👍 bench-confirmation step.
 *
 * That direct promotion is privileged: it lets one person reshape the
 * squad. We allow it in exactly two situations:
 *
 *   (a) the sender is an org ADMIN/OWNER (roster surgery — already
 *       shipped), OR
 *   (b) SELF-REPLACE — the sender is the very player being moved OUT.
 *       "replace me with Aydín", "I'm out, bring Aydín in for me",
 *       "can't make it, give my spot to Aydín from the bench". A player
 *       giving up THEIR OWN slot to a named bench player is allowed to
 *       action it directly; they're only spending their own place.
 *
 * What this must NOT enable: an unrelated non-admin nominating a drop
 * for SOMEONE ELSE ("Bilal: replace Ehtisham with Aydín" when Bilal is
 * neither admin nor Ehtisham). That stays a suggestion, never an
 * auto-promotion.
 *
 * This module is intentionally DB-free and pure so the gate can be unit
 * tested in isolation; the caller (analyze/route.ts) resolves the names
 * to userIds and feeds them in.
 */

export type PromoteRegisterAction = "IN" | "OUT" | "BENCH";

export interface PromoteRegisterEntry {
  /** Resolved org user id for this entry's name, or null when the name
   *  couldn't be resolved to a member. */
  userId: string | null;
  action: PromoteRegisterAction;
}

export interface PromoteAuthorizationInput {
  /** The resolved sender's user id, or null when the sender couldn't be
   *  identified (anonymous @lid / unknown pushname). A null sender can
   *  never satisfy the self-replace branch. */
  senderUserId: string | null;
  /** True when the sender is an OWNER/ADMIN of the org. */
  senderIsAdmin: boolean;
  /** The verdict's registerFor entries, with each name already resolved
   *  to a userId (null when unresolved). */
  entries: PromoteRegisterEntry[];
}

/**
 * Decide whether a bench player named in an IN entry may be promoted
 * straight into the squad (promoteFromBench) for THIS sender.
 *
 * Returns true when:
 *   - the sender is an admin (any IN promotion is allowed), OR
 *   - the batch is a self-replace: the sender themselves is one of the
 *     OUT targets in the same registerFor set (they're giving up their
 *     own slot to make room for the incoming bench player).
 *
 * A non-admin who is NOT among the OUT targets gets `false` — their IN
 * stays the default, idempotent, capacity-only registration (no
 * promotion), which is exactly the unrelated-third-party guard.
 */
export function isPromoteFromBenchAuthorized(
  input: PromoteAuthorizationInput,
): boolean {
  if (input.senderIsAdmin) return true;
  return isSelfReplace(input.senderUserId, input.entries);
}

/**
 * True when the sender is being dropped (OUT) by one of the entries —
 * i.e. this is the sender giving up their own slot. Requires a resolved
 * sender id; a null/unknown sender is never a self-replace.
 */
export function isSelfReplace(
  senderUserId: string | null,
  entries: PromoteRegisterEntry[],
): boolean {
  if (!senderUserId) return false;
  return entries.some(
    (e) => e.action === "OUT" && e.userId !== null && e.userId === senderUserId,
  );
}
