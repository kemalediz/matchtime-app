/**
 * The pool pages' copy with the pool's numbers filled in (slice L2).
 * CLIENT-SAFE. The ONE way a pool page gets its words: the wording is in
 * src/lib/i18n/pool-play.*.ts, the numbers here come from rules.ts.
 */
import { poolPlayCopy, type PoolErrorKey, type PoolPlayCopy, type PoolPlayFacts } from "../i18n/pool-play";
import type { Lang } from "../i18n/lang";
import type { PoolFieldErrors } from "./profile-fields";
import { POOL_CAPS, POOL_CONFIRM, POOL_MIN_AGE } from "./rules";

export const POOL_PAGE_FACTS: PoolPlayFacts = Object.freeze({
  minAge: POOL_MIN_AGE,
  perWeek: POOL_CAPS.perPlayerPerWeek,
  codeDays: POOL_CONFIRM.codeTtlDays,
});

export function poolPageCopy(lang: Lang): PoolPlayCopy {
  return poolPlayCopy(lang, POOL_PAGE_FACTS);
}

/** The message for each field's error code (`profile-fields.ts`). */
export function fieldErrorKeys(errors: PoolFieldErrors): Partial<Record<keyof PoolFieldErrors, PoolErrorKey>> {
  const out: Partial<Record<keyof PoolFieldErrors, PoolErrorKey>> = {};
  if (errors.name) out.name = "name";
  if (errors.area) out.area = `area-${errors.area}` as PoolErrorKey;
  if (errors.maxMiles) out.maxMiles = "maxMiles";
  if (errors.availability) out.availability = `availability-${errors.availability}` as PoolErrorKey;
  if (errors.sports) out.sports = `sports-${errors.sports}` as PoolErrorKey;
  if (errors.adult) out.adult = "adult";
  if (errors.consent) out.consent = "consent";
  return out;
}
