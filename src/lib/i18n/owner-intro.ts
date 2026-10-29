/**
 * Kemal's introduction messages (2026-10-29): the three ready-made posts the
 * platform owner pastes into WhatsApp groups to introduce MatchTime, sent to
 * him by DM when he asks (`src/lib/owner-intro.ts`). CLIENT-SAFE.
 *
 * Written in his voice ("I built", "I run another football group"), so they
 * go to the platform owner only. Both languages go out every time, one
 * bubble each, so each copies whole: this is not "the reader's language".
 *
 * One object per language (`owner-intro.en.ts`, `owner-intro.tr.ts`), typed
 * here, as `pool-club-share.ts`. House rules (unit tested in
 * `src/lib/__tests__/owner-intro.test.ts`): no em or en dashes, no slash as
 * a separator, never "waiting list", Turkish never equal to English, and
 * category 3 names the profile's own "Play elsewhere too" heading.
 */
import { normaliseLang, type Lang } from "./lang";
import { OWNER_INTRO_EN } from "./owner-intro.en";
import { OWNER_INTRO_TR } from "./owner-intro.tr";

export interface OwnerIntroCopy {
  /** 1: football groups he plays in that do not know MatchTime. `siteUrl` is the home page. */
  footballGroups: (siteUrl: string) => string;
  /** 2: groups that are not about football: the player pool invite. `playUrl` is /play. */
  poolInvite: (playUrl: string) => string;
  /** 3: clubs already using MatchTime: the new features. */
  newFeatures: () => string;
}

const BY_LANG: Record<Lang, OwnerIntroCopy> = { en: OWNER_INTRO_EN, tr: OWNER_INTRO_TR };

export function ownerIntroCopy(lang: Lang | string | null | undefined): OwnerIntroCopy {
  return BY_LANG[normaliseLang(lang)];
}
