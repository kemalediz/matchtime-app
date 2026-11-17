/**
 * Is a member ACTIVE at this club? Derived from real play, per club.
 *
 * The admin player pages (positions, phones, ratings) badge a member
 * "Inactive" and hide him under their default "Active" filter. They used
 * to read `User.isActive`, a GLOBAL flag that `scripts/rebuild-sutton.ts`
 * wrote once on 18 Apr 2026 ("appeared in Jan to Apr lineups") and that
 * nothing ever updated again, so Sutton regulars who play every week were
 * shown as Inactive (2026-11-17). `User.isActive` keeps its other meaning,
 * "merged away or deactivated", for the squad and merge code that reads it.
 *
 * The rule, in one sentence: active means a CONFIRMED attendance at a
 * played match of THIS club (kicked off, not cancelled) within the stats
 * page's window, `RANKED_TABLE_INACTIVE_AFTER_MONTHS`; or joining this
 * club within that window, because a member who joined last week and has
 * not had a game yet is new, not inactive.
 */
import { NOT_CANCELLED } from "@/lib/played-match";
import { rankedTableCutoff } from "@/lib/ranked-table-activity";

/** Pure. A join or a game exactly at the cutoff is inside the window. */
export function isActiveInClub(
  member: { joinedAt: Date; playedInWindow: boolean },
  now: Date = new Date(),
): boolean {
  if (member.playedInWindow) return true;
  return member.joinedAt.getTime() >= rankedTableCutoff(now).getTime();
}

interface AttendanceGrouper {
  attendance: {
    // Typed loosely so the rule can be tested without a Prisma client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groupBy(args: any): Promise<any[]>;
  };
}

/**
 * Which of these members played at this club inside the window. ONE
 * grouped query for the whole roster, never one per player.
 */
export async function loadRecentlyPlayedUserIds(
  db: AttendanceGrouper,
  orgId: string,
  userIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = (await db.attendance.groupBy({
    by: ["userId"],
    where: {
      userId: { in: userIds },
      status: "CONFIRMED",
      match: {
        activity: { orgId },
        ...NOT_CANCELLED,
        date: { gte: rankedTableCutoff(now), lte: now },
      },
    },
  })) as Array<{ userId: string }>;
  return new Set(rows.map((r) => r.userId));
}
