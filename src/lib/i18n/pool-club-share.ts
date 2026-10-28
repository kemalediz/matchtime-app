/**
 * The words of a club's ONE share post (growth slice G3, 2026-10-24): the
 * post MatchTime puts in the players' group when an organiser taps Send on
 * the "Tell your players about the player pool" card in club settings, and
 * the card's own words. CLIENT-SAFE.
 *
 * One object per language (`pool-club-share.en.ts`, `pool-club-share.tr.ts`),
 * typed by `PoolClubShareCopy`, so a missing line in either language is a
 * `tsc` error, as `pool-share.ts`. House rules (unit tested in
 * `src/lib/pool/__tests__/club-share-copy.test.ts`): no em or en dashes, no
 * slash as a separator, never "waiting list", Turkish never equal to
 * English, and the post carries nothing but the club's campaign link: no
 * member's name, no number.
 */
import { normaliseLang, type Lang } from "./lang";
import { POOL_CLUB_SHARE_EN } from "./pool-club-share.en";
import { POOL_CLUB_SHARE_TR } from "./pool-club-share.tr";

export interface PoolClubShareCopy {
  /** The post in the players' group. `url` is the club's /play?src= link. */
  post: (url: string) => string;
  /** The settings card. */
  title: string;
  lead: string;
  previewLabel: string;
  send: string;
  sending: string;
  /** After the tap, when it goes out at once. */
  queued: string;
  /** After the tap, inside the club's quiet hours. `when` is a London date and time. */
  held: (when: string) => string;
  /** Tapped, the post not out yet: it goes out in a minute or two. */
  queuedSoon: string;
  /** Tapped, held until later today. `time` is London HH:mm. */
  queuedToday: (time: string) => string;
  /** Tapped, held until another day. `date` is "29 Oct 2026", `time` HH:mm. */
  queuedOn: (date: string, time: string) => string;
  /** Afterwards, for good. `date` is the day it went out ("28 Oct 2026"). */
  sentOn: (date: string) => string;
  /** No players' group connected yet (or the bot is off for it). */
  noGroup: string;
  failed: string;
}

const BY_LANG: Record<Lang, PoolClubShareCopy> = { en: POOL_CLUB_SHARE_EN, tr: POOL_CLUB_SHARE_TR };

export function poolClubShareCopy(lang: Lang | string | null | undefined): PoolClubShareCopy {
  return BY_LANG[normaliseLang(lang)];
}
