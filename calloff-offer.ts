/**
 * The call-off offer's copy in the club's language. The tables are
 * `calloff-offer.en.ts` and `calloff-offer.tr.ts`; anything unknown is
 * English, as `t()` does.
 */
import { normaliseLang, type Lang } from "./lang";
import { calloffOfferEn, type CalloffOfferStrings } from "./calloff-offer.en";
import { calloffOfferTr } from "./calloff-offer.tr";

export type { CalloffOfferStrings };

export const CALLOFF_OFFER_TABLES: Readonly<Record<Lang, CalloffOfferStrings>> = { en: calloffOfferEn, tr: calloffOfferTr };

export function calloffCopy(lang: Lang | string | null | undefined): CalloffOfferStrings {
  return CALLOFF_OFFER_TABLES[normaliseLang(lang)];
}
