/**
 * WHO ANNOUNCES THE LIST AND TEAMS (2026-10-14), `Organisation.listAnnouncer`.
 *
 *   "matchtime"   (default, every club before this, Sutton FC included):
 *                 MatchTime posts the squad, the list and the team sheets
 *                 in the players' group, exactly as before.
 *   "organisers"  MatchTime still COLLECTS In and Out in the players'
 *                 group (reactions, ticks), but every post that lists the
 *                 squad goes to the club's admin channel instead
 *                 (admin-channel.ts: the admin group when linked and
 *                 postable, else the existing DM fallback), and no team
 *                 sheet is ever posted in the players' group. The
 *                 organisers reveal both themselves (FNF, 2026-10-14:
 *                 graphics in a separate announcements group).
 *
 * PURE, no Prisma, so the composer (pipeline/compose.ts) and the client
 * settings component can import it.
 *
 * FOR OTHER MODULES (the HQ team review): call `organisersAnnounce(org)`
 * with any object carrying `listAnnouncer` (an Organisation row, or
 * `OrgFeatures`), or `loadOrganisersAnnounce(orgId)` from
 * list-announcer-store.ts when only the id is in hand.
 */

export type ListAnnouncer = "matchtime" | "organisers";

export const LIST_ANNOUNCERS: readonly ListAnnouncer[] = ["matchtime", "organisers"];

/** Anything the code does not recognise reads as "matchtime": today's behaviour. */
export function normaliseListAnnouncer(v: string | null | undefined): ListAnnouncer {
  return v === "organisers" ? "organisers" : "matchtime";
}

/** True when the club's organisers announce the list and teams themselves. */
export function organisersAnnounce(org: { listAnnouncer?: string | null } | null | undefined): boolean {
  return normaliseListAnnouncer(org?.listAnnouncer) === "organisers";
}
