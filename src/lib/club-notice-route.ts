/**
 * WHERE A CLUB HEARS SOMETHING THE WHOLE CLUB SHOULD KNOW, the I/O half:
 * the club's groups read once, the rule in `club-notice-route-rules.ts`.
 */
import { db } from "./db";
import { isGroupPostable } from "./group-postability-store";
import { clubNoticeRoute, type ClubNoticeRoute } from "./club-notice-route-rules";

/** The club's fields the route needs. */
export const CLUB_NOTICE_ROUTE_SELECT = { adminGroupId: true, whatsappGroupId: true, whatsappBotEnabled: true } as const;

/** The route for a club already read with `CLUB_NOTICE_ROUTE_SELECT`. */
export async function clubNoticeRouteOf(org: { adminGroupId?: string | null; whatsappGroupId?: string | null; whatsappBotEnabled?: boolean | null }): Promise<ClubNoticeRoute> {
  return clubNoticeRoute({
    adminGroupId: org.adminGroupId ?? null,
    whatsappGroupId: org.whatsappGroupId ?? null,
    whatsappBotEnabled: org.whatsappBotEnabled === true,
    playersGroupPostable: org.whatsappGroupId ? await isGroupPostable(org.whatsappGroupId) : false,
  });
}

/** The route for a club by id; a club that is gone: the admin channel (which finds nobody). */
export async function loadClubNoticeRoute(orgId: string): Promise<ClubNoticeRoute> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: CLUB_NOTICE_ROUTE_SELECT });
  return org ? clubNoticeRouteOf(org) : "admin-channel";
}
