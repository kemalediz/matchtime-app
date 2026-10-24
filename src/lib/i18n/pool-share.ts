/**
 * The words of the pool's sharing (growth slice G1, 2026-10-24): the "Bring
 * a friend" card on /play/manage and /profile, the ready-to-forward message
 * it opens in WhatsApp, and the "invited you" line on /play. CLIENT-SAFE.
 *
 * One object per language (`pool-share.en.ts`, `pool-share.tr.ts`), typed by
 * `PoolShareCopy`, so a missing line in either language is a `tsc` error,
 * as `pool-play.ts`. House rules (unit tested in
 * `src/lib/pool/__tests__/growth-copy.test.ts`): no em or en dashes, no
 * slash as a separator, never "waiting list", Turkish never equal to
 * English, and the message never carries anything but the link.
 */
import { normaliseLang, type Lang } from "./lang";
import { POOL_SHARE_EN } from "./pool-share.en";
import { POOL_SHARE_TR } from "./pool-share.tr";

export interface PoolShareCopy {
  heading: string;
  intro: string;
  linkLabel: string;
  messageLabel: string;
  copyLink: string;
  copied: string;
  copyFailed: string;
  shareWhatsApp: string;
  /** His name is shown to people who open his link (the privacy switch is on). */
  recognitionOn: (name: string) => string;
  recognitionOff: string;
  /** The ready-to-forward message. `url` is his /play?ref= link. */
  message: (url: string) => string;
  /** The line on /play for someone who opened a friend's link. */
  invitedBy: (name: string) => string;
}

const BY_LANG: Record<Lang, PoolShareCopy> = { en: POOL_SHARE_EN, tr: POOL_SHARE_TR };

export function poolShareCopy(lang: Lang | string | null | undefined): PoolShareCopy {
  return BY_LANG[normaliseLang(lang)];
}
