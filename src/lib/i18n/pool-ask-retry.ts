/**
 * A refused pool ask, asked again once the venue is set (2026-10-28), in
 * the club's language. The tables are `pool-ask-retry.en.ts` and
 * `pool-ask-retry.tr.ts`; anything unknown is English, as `t()` does.
 */
import { normaliseLang, type Lang } from "./lang";
import { poolAskRetryEn, type PoolAskRetryStrings } from "./pool-ask-retry.en";
import { poolAskRetryTr } from "./pool-ask-retry.tr";

export type { PoolAskRetryStrings };

export const POOL_ASK_RETRY_TABLES: Readonly<Record<Lang, PoolAskRetryStrings>> = { en: poolAskRetryEn, tr: poolAskRetryTr };

export function askRetryCopy(lang: Lang | string | null | undefined): PoolAskRetryStrings {
  return POOL_ASK_RETRY_TABLES[normaliseLang(lang)];
}

/** The post: why it happens now, then the ask's own reply, unchanged. */
export function venueSetRetryText(lang: Lang | string | null | undefined, r: { asked: boolean; replyText: string }): string {
  const c = askRetryCopy(lang);
  return `${r.asked ? c.venue_set_asked : c.venue_set_refused}\n${r.replyText}`;
}
