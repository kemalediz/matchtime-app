/**
 * A MEMBER TAKEN OFF A CLUB IS TAKEN OFF ITS UPCOMING MATCHES (FNF,
 * 2026-10-24).
 *
 * Every roster reader (the pipeline's `load-state.ts`, the squad posts, the
 * resolver) works from memberships with `leftAt` null. A removal that sets
 * `leftAt` and leaves the player's CONFIRMED or BENCH row on a match still
 * to come leaves a place nobody can name or take back: FNF's HQ squad post
 * read "Bench (1): 1. a player" for "Glazers", removed on the players page
 * with his bench row in place, and "Glazers out" could not find him.
 *
 * So every writer that ends a membership calls this AFTER the `leftAt`
 * write. Each live row on a match of THIS club that has not kicked off and
 * is not finished or cancelled goes through `cancelAttendance`, the one
 * drop writer: the AttendanceEvent is written in the same transaction, and
 * a freed CONFIRMED place follows the club's bench rules exactly as any
 * drop (an offer to the bench, or the organisers' pick in an organiser-pick
 * club). Nothing is said to the player for this. Because `leftAt` is
 * already set, the partner-guest "taken off" DM in `cancelAttendance`
 * does not fire either (it skips a closed membership).
 *
 * Past matches are never read: their history stays as it was.
 *
 * THE WRITERS OF `Membership.leftAt`, AND WHICH CALL THIS:
 *   - `removeProvisionalPlayer` (admin players page "Remove"): calls it,
 *     actor the admin. The page's confirm already promises "they won't
 *     appear in future matches". The one ORGANISER removal: it also stamps
 *     `removedByOrganiserAt`, which shuts this club's guest doors to him
 *     (`guest-door-rules.ts`, Kemal 2026-10-31).
 *   - `api/whatsapp/group-leave` (he left the WhatsApp group): calls it,
 *     actor `system`. He can no longer read the group, a place held for
 *     him is printed nameless and cannot be dropped by "X out". A rejoin
 *     reactivates the membership, and he says IN again like anyone. Also
 *     stamps `removedByOrganiserAt` when the Pi names a remover who is an
 *     OWNER or ADMIN of the club and not him (group-leave-rules.ts); a
 *     person leaving himself, or an old Pi payload, is never stamped.
 *   - `partner-guest.ts standDownVolunteers`: does not. It already drops
 *     the guest's BENCH row (cause partner-ask) before closing the guest
 *     membership, and keeps a place he was picked for on purpose.
 *   - `partner-guest.ts retirePastGuests`: does not. A guest membership is
 *     for one match and is retired only after it is played or cancelled,
 *     so there is no upcoming row of his left to drop.
 *   - `merge-players-core.ts`: does not. The survivor's `leftAt` is set
 *     only when BOTH rows had left; the merge remaps the rows itself.
 *   - `group-add.ts`, `admin-group-link.ts` write `UnsolicitedGroup.leftAt`
 *     and `month-signup.ts` writes `SquadMonthMember.leftAt`: not a club
 *     membership, out of scope.
 *   - `scripts/cleanup-removed-members-upcoming.ts`: the one-off for rows
 *     left behind before this existed (dry run by default).
 */
import { db } from "./db";
import { cancelAttendance } from "./attendance";
import type { AttendanceEventContext } from "./attendance-events";

export const MEMBER_REMOVED_CAUSE = "member-removed" as const;

/** A match a removed member can still be taken off: not started, not over. */
export const NOT_YET_PLAYED_STATUSES = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export interface TakenOff {
  matchId: string;
  fromStatus: "CONFIRMED" | "BENCH";
}

/**
 * Drops `userId`'s CONFIRMED and BENCH rows on `orgId`'s matches that have
 * not kicked off, through `cancelAttendance` with `event`. Does nothing
 * when the membership is live (he is back, or this was called by mistake):
 * the membership's `leftAt` is the fact this acts on. Never throws; a drop
 * that fails is logged and the rest still happen.
 */
export async function takeRemovedMemberOffUpcomingMatches(args: {
  userId: string;
  orgId: string;
  event: AttendanceEventContext;
  now?: Date;
}): Promise<TakenOff[]> {
  const { userId, orgId, event } = args;
  const now = args.now ?? new Date();
  const out: TakenOff[] = [];
  try {
    const membership = await db.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      select: { leftAt: true },
    });
    if (!membership?.leftAt) return out;

    const rows = await db.attendance.findMany({
      where: {
        userId,
        status: { in: ["CONFIRMED", "BENCH"] },
        match: {
          activity: { orgId },
          date: { gt: now },
          status: { in: [...NOT_YET_PLAYED_STATUSES] },
        },
      },
      select: { matchId: true, status: true },
      orderBy: { match: { date: "asc" } },
    });

    for (const r of rows) {
      try {
        await cancelAttendance(userId, r.matchId, event);
        out.push({ matchId: r.matchId, fromStatus: r.status as TakenOff["fromStatus"] });
      } catch (err) {
        console.error(
          `[member-removal] user=${userId} org=${orgId} match=${r.matchId}: drop failed:`,
          err instanceof Error ? err.message : "failed",
        );
      }
    }
    if (out.length > 0) {
      console.log(
        `[member-removal] user=${userId} org=${orgId}: taken off ${out.length} upcoming match(es) (${event.sourceRef ?? event.cause})`,
      );
    }
  } catch (err) {
    console.error(`[member-removal] user=${userId} org=${orgId}: lookup failed:`, err instanceof Error ? err.message : "failed");
  }
  return out;
}
