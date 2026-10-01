/**
 * RECLAIMS (slice 2b, 2026-10-01). Plan section 2.1: in an organiser-pick
 * club, a player who was in, said OUT and says IN again while a place is
 * still free gets it back. Shared by the engine's loader
 * (`pipeline/load-state.ts`) and `registerAttendance`, so the react and the
 * write read the same fact.
 */
import { db } from "./db";

/**
 * Of these DROPPED players, the ones whose last move on the match was
 * CONFIRMED to DROPPED (slice 2b). Read from the append-only
 * `AttendanceEvent` log, newest first, so an earlier bench-to-dropped move
 * does not count and a later one does.
 */
export async function loadReclaimUserIds(matchId: string, droppedUserIds: string[]): Promise<string[]> {
  if (droppedUserIds.length === 0) return [];
  const events = await db.attendanceEvent.findMany({
    where: { matchId, userId: { in: droppedUserIds }, toStatus: "DROPPED" },
    orderBy: { at: "desc" },
    select: { userId: true, fromStatus: true },
  });
  const latest = new Map<string, string | null>();
  for (const e of events) if (!latest.has(e.userId)) latest.set(e.userId, e.fromStatus);
  return droppedUserIds.filter((id) => latest.get(id) === "CONFIRMED");
}
