/**
 * Is a member ACTIVE at this club, for the admin player pages?
 *
 * The positions, phones and ratings pages badge a member "Inactive" and
 * hide him under their default "Active" filter. They read `User.isActive`,
 * a GLOBAL flag that `scripts/rebuild-sutton.ts` wrote once on 18 Apr 2026
 * ("appeared in Jan to Apr lineups") and that nothing updated again, so
 * Sutton regulars who play every week were shown as Inactive (2026-11-17).
 *
 * The fix is deliberately narrow: active = `User.isActive` OR played for
 * THIS club within the stats page's window
 * (`RANKED_TABLE_INACTIVE_AFTER_MONTHS`). It rescues the members who
 * actually play and leaves everyone else's value as it was; making group
 * members who have not played lately newly Inactive would be a product
 * change nobody asked for. "Played" is the stats page's own definition
 * (`playedAttendanceWhere`: CONFIRMED, COMPLETED, not historical), so the
 * admin pages and the leaderboards agree. `User.isActive` keeps its other
 * meaning, "merged away or deactivated", for the squad and merge code.
 */
import { playedAttendanceWhere, rankedTableCutoff } from "@/lib/ranked-table-activity";

/** Pure. */
export function isActiveInClub(member: { globalIsActive: boolean; playedInWindow: boolean }): boolean {
  return member.globalIsActive || member.playedInWindow;
}

interface AttendanceGrouper {
  attendance: {
    // Typed loosely so the rule can be tested without a Prisma client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groupBy(args: any): Promise<any[]>;
  };
}

/**
 * Which of these members played for this club inside the window. ONE
 * grouped query for the whole roster, never one per player. A match at
 * exactly the cutoff is inside the window, as in `buildRankedRoster`.
 */
export async function loadRecentlyPlayedUserIds(
  db: AttendanceGrouper,
  orgId: string,
  userIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const played = playedAttendanceWhere(orgId);
  const rows = (await db.attendance.groupBy({
    by: ["userId"],
    where: {
      userId: { in: userIds },
      ...played,
      match: { ...played.match, date: { gte: rankedTableCutoff(now) } },
    },
  })) as Array<{ userId: string }>;
  return new Set(rows.map((r) => r.userId));
}
