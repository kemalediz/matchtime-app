/**
 * A CLUB'S OWN PLAYER POOL SWITCH, the pure half (2026-10-28). The I/O is
 * `club-switch.ts`.
 *
 * When a club's pool goes from off to on (by whoever), the club is told
 * ONCE, ever (Kemal 2026-10-28), where the shared rule sends it
 * (`club-notice-route-rules.ts` `clubNoticeRoute`): HQ through its admin
 * channel; a club whose only group is its players' group, ONE post there
 * worded for everyone (organisers ask, players read) and NO admin DM; no
 * postable group, the admin DMs.
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
