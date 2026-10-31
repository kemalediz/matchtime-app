/**
 * A GUEST JOINING OR LEAVING A GAME, TOLD WHERE THE CLUB CAN SEE IT
 * (Kemal, 2026-10-29): "it needs to be shown in the group, either HQ group
 * or players group, depending on the type of the football club, so that
 * everyone is aware that there is a person joining from outside." The same
 * day he ruled that a guest from a PARTNER club is told the same way as a
 * guest from the MatchTime player pool. Callers: `pool/guest-notice.ts`
 * (the pool) and `partner-guest.ts` (a partner club's player).
 *
 * The shared route (`club-notice-route-rules.ts` `clubNoticeRoute`):
 *
 *   a linked admin group (HQ)   the admin channel (`sendAdminNotice`), with
 *                               the organisers' words (`hqText`);
 *   only a players' group       ONE post in that group (BotJob kind
 *                               "group"), worded for everyone
 *                               (`groupText`, nothing organiser-only);
 *                               NO admin DM;
 *   neither one postable        the admin channel, which DMs the admins.
 *
 * Each notice is claimed once (`SentNotification`, the caller's key and
 * kind) in the same transaction as its job, so a double tap or a retry
 * never repeats it. The admin channel goes out at once; the players' group
 * post waits for the club's quiet hours to end, as every unprompted post in
 * that group does.
 */
import { db } from "./db";
import { sendAdminNotice, type AdminNoticeClient } from "./admin-channel";
import { CLUB_NOTICE_ROUTE_SELECT, clubNoticeRouteOf } from "./club-notice-route";
import { QUIET_HOURS_SELECT, messageHoursSendAfter, quietHoursOf } from "./message-hours";

export type GuestNoticeOutcome = "admin-channel" | "players-group" | "told-already" | "none";

export async function tellClubAboutGuest(a: {
  orgId: string;
  matchId: string;
  /** The once-ever claim for this notice. */
  key: string;
  /** The claim's kind, the caller's own ("pool-guest", "xask-volunteer"). */
  kind: string;
  now: Date;
  /** The organisers' words (HQ or their DMs). */
  hqText: string;
  /** The players' group words: for everyone, nothing organiser-only. */
  groupText: string;
  /** "players-group-first": the players' group even in a club with HQ
   *  (a member's friend joining, friend link D8). Default: the club's route. */
  prefer?: "club" | "players-group-first";
}): Promise<GuestNoticeOutcome> {
  const org = await db.organisation.findUnique({ where: { id: a.orgId }, select: { ...CLUB_NOTICE_ROUTE_SELECT, ...QUIET_HOURS_SELECT } });
  if (!org) return "none";
  const route = await clubNoticeRouteOf(org, a.prefer ?? "club");
  const queued = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key: a.key, kind: a.kind, matchId: a.matchId }], skipDuplicates: true });
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
  console.log(`[guest-notice] club ${a.orgId}: guest notice ${a.key} via ${route}`);
  return route;
}
