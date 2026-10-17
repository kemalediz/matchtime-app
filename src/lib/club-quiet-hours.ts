/**
 * A club's quiet hours, read from its Organisation row (2026-10-16). The
 * DB half of `quietHoursOf` (message-hours.ts), for the callers that queue
 * or gate a club's message without the row at hand. Callers that already
 * load the club's row add `QUIET_HOURS_SELECT` to it instead.
 *
 * A missing row means the default (ON, 23:00 to 09:00): today's behaviour.
 */
import { db } from "./db";
import { QUIET_HOURS_SELECT, quietHoursOf, type QuietHours } from "./message-hours";

export async function loadClubQuietHours(orgId: string): Promise<QuietHours> {
  const row = await db.organisation.findUnique({ where: { id: orgId }, select: QUIET_HOURS_SELECT });
  return quietHoursOf(row);
}
