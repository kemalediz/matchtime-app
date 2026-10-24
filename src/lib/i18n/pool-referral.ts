/**
 * The words of referral badges and "Brought by" (growth slice G4,
 * 2026-10-24): the badge lines in the club's badges post, the "Players
 * brought to the game" card on the stats page, and the "Brought by" line
 * on the organisers' notice for a friend's first game. CLIENT-SAFE.
 *
 * One object per language, typed by `PoolReferralCopy`, so a missing line
 * in either language is a `tsc` error (as `pool-share.ts`). Badge names stay
 * English in every language, as every badge's. House rules (unit tested in
 * `src/lib/pool/__tests__/referral-copy.test.ts`): no em or en dashes, no
 * slash between words, never "waiting list", Turkish never equal to English.
 */
import type { ReferralBadgeKey } from "../badge-rules";
import { normaliseLang, type Lang } from "./lang";
import { POOL_REFERRAL_EN } from "./pool-referral.en";
import { POOL_REFERRAL_TR } from "./pool-referral.tr";

export interface PoolReferralCopy {
  /** One line of the club's badges post: everyone who earned `key` this time. */
  postLine: (p: { key: ReferralBadgeKey; emoji: string; label: string; names: string[]; friends: number }) => string;
  /** The stats page card. */
  statsTitle: string;
  statsCount: (n: number) => string;
  statsHowItCounts: string;
  statsPrivate: string;
  /** Under each badge on the stats page. */
  badgeHint: (friends: number) => string;
  /** Appended to the organisers' notice when a friend plays his first game. */
  broughtBy: (name: string) => string;
}

const BY_LANG: Record<Lang, PoolReferralCopy> = { en: POOL_REFERRAL_EN, tr: POOL_REFERRAL_TR };

export function poolReferralCopy(lang: Lang | string | null | undefined): PoolReferralCopy {
  return BY_LANG[normaliseLang(lang)];
}
