/**
 * A POOL GUEST JOINING OR LEAVING A GAME, TOLD WHERE THE CLUB CAN SEE IT
 * (Kemal, 2026-10-29). The route, the once-only claim and the quiet hours
 * are the shared guest notice (`../guest-notice.ts`), the same one a
 * partner club's guest is told by. The pool's own part: its claim kind,
 * and its words (HQ keeps the turn-up record line; the players' group post
 * leaves it out, as another club's history about a stranger is not for the
 * whole group).
 */
import { tellClubAboutGuest, type GuestNoticeOutcome } from "../guest-notice";

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
}): Promise<GuestNoticeOutcome> {
  return tellClubAboutGuest({ ...a, kind: POOL_GUEST_NOTICE_KIND });
}
