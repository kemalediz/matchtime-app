/**
 * A POOL GUEST JOINING OR LEAVING A GAME, TOLD WHERE THE CLUB CAN SEE IT
 * (Kemal, 2026-10-29): "it needs to be shown in the group, either HQ group
 * or players group, depending on the type of the football club, so that
 * everyone is aware that there is a person joining from outside."
 *
 * The shared route (`club-notice-route-rules.ts` `clubNoticeRoute`):
 *
 *   a linked admin group (HQ)   the admin channel, as before
 *                               (`sendAdminNotice`), with the organisers'
 *                               words: the turn-up record line kept;
 *   only a players' group       ONE post in that group (BotJob kind
 *                               "group"), worded for everyone and without
 *                               the turn-up record; NO admin DM;
 *   neither one postable        the admin channel, which DMs the admins.
 *
 * Each notice is claimed once (`SentNotification`, the caller's key, kind
 * "pool-guest") in the same transaction as its job, so a double tap or a
 * retry never repeats it. The admin channel goes out at once, as it always
 * has; the players' group post waits for the club's quiet hours to end, as
 * every unprompted post in that group does.
 */
import { db } from "../db";
import { sendAdminNotice, type AdminNoticeClient } from "../admin-channel";
import { CLUB_NOTICE_ROUTE_SELECT, clubNoticeRouteOf } from "../club-notice-route";
import { QUIET_HOURS_SELECT, messageHoursSendAfter, quietHoursOf } from "../message-hours";

export const POOL_GUEST_NOTICE_KIND = "pool-guest" as const;

export async function tellClubAboutPoolGuest(a: {
  orgId: string;
  matchId: string;
  /** The once-ever claim for this notice. */
  key: string;
  now: Date;
  /** The organisers' words (HQ or their DMs): the turn-up line kept. */
  hqText: string;
  /** The players' group words: for everyone, no turn-up line. */
  groupText: string;
}): Promise<"admin-channel" | "players-group" | "told-already" | "none"> {
  const org = await db.organisation.findUnique({ where: { id: a.orgId }, select: { ...CLUB_NOTICE_ROUTE_SELECT, ...QUIET_HOURS_SELECT } });
  if (!org) return "none";
  const route = await clubNoticeRouteOf(org);
  const queued = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key: a.key, kind: POOL_GUEST_NOTICE_KIND, matchId: a.matchId }], skipDuplicates: true });
    if (count !== 1) return false;
    if (route === "players-group") {
      const sendAfter = messageHoursSendAfter(a.now, quietHoursOf(org));
      await tx.botJob.create({ data: { orgId: a.orgId, kind: "group", text: a.groupText, matchId: a.matchId, ...(sendAfter ? { sendAfter } : {}) } });
    } else {
      await sendAdminNotice({ orgId: a.orgId, now: a.now, holdOvernight: false, text: a.hqText, client: tx as unknown as AdminNoticeClient });
    }
    return true;
  });
  if (!queued) return "told-already";
  console.log(`[pool] club ${a.orgId}: pool guest notice ${a.key} via ${route}`);
  return route;
}
