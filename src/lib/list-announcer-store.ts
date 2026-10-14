/**
 * The database half of list-announcer.ts: read one club's setting by id.
 * A failed read is "matchtime" (today's behaviour), never a throw: a club
 * that cannot be read keeps the posts it has always had.
 */
import { db } from "./db";
import { organisersAnnounce } from "./list-announcer";

export async function loadOrganisersAnnounce(orgId: string): Promise<boolean> {
  try {
    const row = await db.organisation.findUnique({ where: { id: orgId }, select: { listAnnouncer: true } });
    return organisersAnnounce(row);
  } catch (err) {
    console.error(`[list-announcer] org ${orgId}: setting could not be read; MatchTime announces:`, err);
    return false;
  }
}
