/**
 * WHERE A CLUB HEARS SOMETHING THE WHOLE CLUB SHOULD KNOW, the pure half
 * (Kemal, 2026-10-28 and 2026-10-29). The I/O is `club-notice-route.ts`.
 *
 *   a linked admin group (HQ)   its admin channel (`sendAdminNotice`: the
 *                               admin group, the one person it chose, or
 *                               each admin), never the players' group;
 *   only a players' group       ONE post in that group, worded for everyone,
 *                               and NO admin DM at all;
 *   neither one postable        the admin channel, which DMs the admins.
 *
 * Used by the once-ever "the pool is on" message (`pool/club-switch.ts`)
 * and by every pool guest joining or leaving a game (`pool/accept.ts`).
 */
export type ClubNoticeRoute = "admin-channel" | "players-group";

export interface ClubNoticeRouteInput {
  adminGroupId: string | null;
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  /** False only when MatchTime is known to be unable to post in the players' group. */
  playersGroupPostable: boolean;
}

/** Where the club is told: its admin channel, or its players' group. */
export function clubNoticeRoute(org: ClubNoticeRouteInput): ClubNoticeRoute {
  if (org.adminGroupId) return "admin-channel";
  if (org.whatsappGroupId && org.whatsappBotEnabled && org.playersGroupPostable) return "players-group";
  return "admin-channel";
}
