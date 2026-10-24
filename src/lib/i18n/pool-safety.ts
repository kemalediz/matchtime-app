/**
 * The pool's no-show, block and report copy in the language asked for
 * (slice L7). The tables are `pool-safety.en.ts` and `pool-safety.tr.ts`;
 * anything unknown is English, as `t()` does.
 */
import { normaliseLang, type Lang } from "./lang";
import { poolSafetyEn, type PoolSafetyStrings } from "./pool-safety.en";
import { poolSafetyTr } from "./pool-safety.tr";

export type { PoolSafetyStrings };

export const POOL_SAFETY_TABLES: Readonly<Record<Lang, PoolSafetyStrings>> = { en: poolSafetyEn, tr: poolSafetyTr };

export function poolSafetyCopy(lang: Lang | string | null | undefined): PoolSafetyStrings {
  return POOL_SAFETY_TABLES[normaliseLang(lang)];
}
