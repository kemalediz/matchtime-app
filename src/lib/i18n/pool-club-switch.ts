/**
 * The words of a club's own "Player pool" switch (2026-10-28): the card on
 * /admin/settings, and the ONE message that tells the club the pool is on
 * for it (`pool/club-switch.ts`): to the admin team, or in the players'
 * group of a club with no admin group. CLIENT-SAFE.
 *
 * One object per language (`pool-club-switch.en.ts`, `pool-club-switch.tr.ts`),
 * typed by `PoolClubSwitchCopy`, so a missing line in either language is a
 * `tsc` error. House rules (unit tested in
 * `src/lib/pool/__tests__/club-switch-copy.test.ts`): no em or en dashes, no
 * slash as a separator, never "free", never "waiting list", Turkish never
 * equal to English. The notice quotes the real card headings (pinned there).
 */
import { normaliseLang, type Lang } from "./lang";
import { POOL_CLUB_SWITCH_EN } from "./pool-club-switch.en";
import { POOL_CLUB_SWITCH_TR } from "./pool-club-switch.tr";

export interface PoolClubSwitchCopy {
  /** The message to the admin team. "group": posted in the club's admin
   *  group (HQ); "dm": sent to each owner and admin when it has none. */
  notice: (club: string, audience: "group" | "dm") => string;
  /** The same news posted in the players' group of a club with no admin
   *  group: everyone reads it, so it says only organisers can ask. */
  groupAnnouncement: (club: string) => string;
  /** The settings card. */
  title: string;
  lead: string;
  /** Asked before switching off. */
  confirmOff: string;
  savedOn: string;
  savedOff: (closedAsks: number) => string;
}

const BY_LANG: Record<Lang, PoolClubSwitchCopy> = { en: POOL_CLUB_SWITCH_EN, tr: POOL_CLUB_SWITCH_TR };

export function poolClubSwitchCopy(lang: Lang | string | null | undefined): PoolClubSwitchCopy {
  return BY_LANG[normaliseLang(lang)];
}
