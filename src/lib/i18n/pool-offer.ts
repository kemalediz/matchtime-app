/**
 * The pool's offer copy in the language asked for (slice L5a). The tables
 * are `pool-offer.en.ts` and `pool-offer.tr.ts`; anything unknown is
 * English, as `t()` does.
 */
import { normaliseLang, type Lang } from "./lang";
import { poolOfferEn, type PoolOfferStrings } from "./pool-offer.en";
import { poolOfferTr } from "./pool-offer.tr";

export type { PoolOfferStrings };

export const POOL_OFFER_TABLES: Readonly<Record<Lang, PoolOfferStrings>> = { en: poolOfferEn, tr: poolOfferTr };

export function poolCopy(lang: Lang | string | null | undefined): PoolOfferStrings {
  return POOL_OFFER_TABLES[normaliseLang(lang)];
}
