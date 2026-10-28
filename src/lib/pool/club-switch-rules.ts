/**
 * A CLUB'S OWN PLAYER POOL SWITCH, the pure half (2026-10-28). The I/O is
 * `club-switch.ts`.
 *
 * When a club's pool goes from off to on (by whoever), the club is told
 * ONCE, ever (`poolOnRoute`, Kemal 2026-10-28):
 *
 *   a linked admin group (HQ)   its admin channel (`sendAdminNotice`: the
 *                               admin group, the one person it chose, or
 *                               each admin), never the players' group;
 *   only a players' group       ONE post in that group, worded for everyone
 *                               (organisers ask, players read), and NO
 *                               admin DM at all;
 *   neither one postable        the admin channel, which DMs the admins.
 *
 * Each route has its own claim, a `SentNotification` key with nothing in it
 * but the club (`poolOnNoticeKey`, `poolOnGroupKey`), written in the same
 * transaction as the message's `BotJob`s, so off and on again, a double
 * tap, or two admins at once never repeat it. Its own key for the group
 * post means a club told by DM before the group post existed is still told
 * in its group once.
 */
export const POOL_ON_NOTICE_KIND = "pool-club-on" as const;

/** The once-ever claim: the club and nothing else. */
export function poolOnNoticeKey(orgId: string): string {
  return `org-${orgId}:${POOL_ON_NOTICE_KIND}`;
}

export const POOL_ON_GROUP_KIND = "pool-club-on-group" as const;

/** The once-ever claim for the players' group post: the club and nothing else. */
export function poolOnGroupKey(orgId: string): string {
  return `org-${orgId}:${POOL_ON_GROUP_KIND}`;
}

export interface PoolOnRouteInput {
  adminGroupId: string | null;
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  /** False only when MatchTime is known to be unable to post in the players' group. */
  playersGroupPostable: boolean;
}

/** Where the club is told: its admin channel, or its players' group. */
export function poolOnRoute(org: PoolOnRouteInput): "admin-channel" | "players-group" {
  if (org.adminGroupId) return "admin-channel";
  if (org.whatsappGroupId && org.whatsappBotEnabled && org.playersGroupPostable) return "players-group";
  return "admin-channel";
}
