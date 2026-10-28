/**
 * A CLUB'S OWN PLAYER POOL SWITCH, the pure half (2026-10-28). The I/O is
 * `club-switch.ts`.
 *
 * When a club's pool goes from off to on (by whoever), its admin team is
 * told ONCE, ever, through the club's own admin channel (`sendAdminNotice`:
 * its admin group, the one person it chose, or each admin). Never the
 * players' group. The claim is a `SentNotification` key with
 * nothing in it but the club (`poolOnNoticeKey`), written in the same
 * transaction as the message's `BotJob`s, so off and on again, a double
 * tap, or two admins at once never repeat it.
 */
export const POOL_ON_NOTICE_KIND = "pool-club-on" as const;

/** The once-ever claim: the club and nothing else. */
export function poolOnNoticeKey(orgId: string): string {
  return `org-${orgId}:${POOL_ON_NOTICE_KIND}`;
}
