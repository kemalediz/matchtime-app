/**
 * Monthly squad set-up copy (2026-10-29), in the club's language. The
 * tables are `month-setup.en.ts` and `month-setup.tr.ts`; anything unknown
 * is English, as `t()` does.
 */
import { normaliseLang, type Lang } from "./lang";
import { monthSetupEn, type MonthSetupStrings } from "./month-setup.en";
import { monthSetupTr } from "./month-setup.tr";

export type { MonthSetupStrings };

export const MONTH_SETUP_TABLES: Readonly<Record<Lang, MonthSetupStrings>> = { en: monthSetupEn, tr: monthSetupTr };

export function monthSetupCopy(lang: Lang | string | null | undefined): MonthSetupStrings {
  return MONTH_SETUP_TABLES[normaliseLang(lang)];
}
