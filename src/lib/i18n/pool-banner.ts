/**
 * The words of the one-line player pool banner on every signed-in page
 * (2026-10-28, `src/lib/pool/banner-rules.ts`). CLIENT-SAFE.
 *
 * One object per language (`pool-banner.en.ts`, `pool-banner.tr.ts`), typed
 * by `PoolBannerCopy`, so a missing line in either language is a `tsc`
 * error. House rules (unit tested in
 * `src/lib/pool/__tests__/banner-copy.test.ts`): no em or en dashes, no
 * slash as a separator, never "free", never "waiting list", no pricing,
 * Turkish never equal to English.
 */
import { normaliseLang, type Lang } from "./lang";
import { POOL_BANNER_EN } from "./pool-banner.en";
import { POOL_BANNER_TR } from "./pool-banner.tr";

export interface PoolBannerInfo {
  title: string;
  /** Two or three short lines. */
  lines: string[];
}

export interface PoolBannerCopy {
  /** The banner's landmark name. */
  region: string;
  join: { text: string; button: string; info: PoolBannerInfo };
  share: { text: string; button: string; info: PoolBannerInfo };
  notInterested: string;
  /** For an owner or admin whose club has not told its players yet. */
  adminLine: string;
}

const BY_LANG: Record<Lang, PoolBannerCopy> = { en: POOL_BANNER_EN, tr: POOL_BANNER_TR };

export function poolBannerCopy(lang: Lang | string | null | undefined): PoolBannerCopy {
  return BY_LANG[normaliseLang(lang)];
}
