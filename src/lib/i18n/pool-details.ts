/**
 * The words of the pool's question about his times and formats (Kemal,
 * 2026-11-04): the welcome's question, the one later question, the line
 * after his answer was saved, and the one "what did you mean?". The /play
 * form asks only the days; MatchTime asks the rest here, in plain words.
 * CLIENT-SAFE.
 *
 * One object per language (`pool-details.en.ts`, `pool-details.tr.ts`),
 * typed by `PoolDetailsCopy`, so a missing line in either language is a
 * `tsc` error, as `pool-share.ts`. House rules (unit tested in
 * `src/lib/pool/__tests__/details-copy.test.ts`): no em or en dashes, no
 * slash as a separator, never "waiting list", no greeting, Turkish never
 * equal to English. Every list and number is passed in (`pool/copy.ts`).
 */
import { normaliseLang, type Lang } from "./lang";
import { POOL_DETAILS_EN } from "./pool-details.en";
import { POOL_DETAILS_TR } from "./pool-details.tr";

export interface PoolDetailsCopy {
  /** The welcome's paragraph. `days`: "Tuesday and Saturday"; `formats`:
   *  the catalogue's, "5, 7, 8, 9 or 11-a-side". */
  question: (p: { days: string; formats: string }) => string;
  /** The ONE later question, if he never answered. */
  ask: (p: { name: string | null; days: string; formats: string; manageLink: string }) => string;
  /** After his answer was saved: what is saved now. */
  saved: (p: { days: string; formats: string; manageLink: string }) => string;
  /** His answer could not be read for sure: asked once what he meant. */
  reask: (p: { manageLink: string }) => string;
  /** A day as saved: the whole day, or its stretches. */
  dayAnyTime: (day: string) => string;
  dayRanges: (day: string, ranges: string) => string;
  /** One stretch; `untilLate` when it runs to midnight. */
  range: (from: string, to: string, untilLate: boolean) => string;
  /** Formats as saved: "5 and 7-a-side"; none means any. */
  formatsSaved: (list: string) => string;
  anyFormat: string;
  /** The catalogue's formats as a choice: "5, 7, 8, 9 or 11-a-side". */
  formatsChoice: (list: string) => string;
}

const BY_LANG: Record<Lang, PoolDetailsCopy> = { en: POOL_DETAILS_EN, tr: POOL_DETAILS_TR };

export function poolDetailsCopy(lang: Lang | string | null | undefined): PoolDetailsCopy {
  return BY_LANG[normaliseLang(lang)];
}
