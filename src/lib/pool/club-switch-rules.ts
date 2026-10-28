/**
 * A CLUB'S OWN PLAYER POOL SWITCH, the pure half (2026-10-28). The I/O is
 * `club-switch.ts`.
 *
 * When a club's pool goes from off to on (by whoever), its admin team is
 * told ONCE, ever: one message in the club's admin group (HQ), or, when the
 * club has no HQ MatchTime can post in, one DM to each owner and admin.
 * Never the players' group. The claim is a `SentNotification` key with
 * nothing in it but the club (`poolOnNoticeKey`), written in the same
 * transaction as the message's `BotJob`s, so off and on again, a double
 * tap, or two admins at once never repeat it.
 */
import type { AdminChannelMode, ChannelAdmin } from "../admin-channel-rules";

export const POOL_ON_NOTICE_KIND = "pool-club-on" as const;

/** The once-ever claim: the club and nothing else. */
export function poolOnNoticeKey(orgId: string): string {
  return `org-${orgId}:${POOL_ON_NOTICE_KIND}`;
}

export type PoolOnNoticeTarget = { to: "group" } | { to: "dm"; users: { id: string; phone: string }[] } | { to: "none" };

/**
 * Where the message goes. HQ when the club's admin messages go to its
 * linked admin group and MatchTime can post there (the admin channel's own
 * test, `admin-channel.ts` `sendAdminNotice`); otherwise every owner and
 * admin with a phone, by DM; nobody to tell: none (nothing is claimed, so
 * the next switch-on tries again).
 */
export function poolOnNoticeTarget(
  ch: { mode: AdminChannelMode; adminGroupId: string | null; adminGroupPostable: boolean | undefined },
  admins: readonly ChannelAdmin[],
): PoolOnNoticeTarget {
  if (ch.mode === "admin-group" && ch.adminGroupId && ch.adminGroupPostable !== false) return { to: "group" };
  const users = admins.filter((a) => !!a.phoneNumber).map((a) => ({ id: a.id, phone: (a.phoneNumber as string).replace(/^\+/, "") }));
  return users.length > 0 ? { to: "dm", users } : { to: "none" };
}
