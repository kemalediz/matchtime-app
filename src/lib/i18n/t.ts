/**
 * `t(lang)`: resolve a language to its string table.
 *
 * A composer does `const s = t(state.features.language)` ONCE and reads
 * `s.key(...)`. Unknown languages fall back to English through
 * `normaliseLang`; a KNOWN language never falls back per key, because
 * the type system has already proven the key exists (`tr` is declared
 * `: Strings`). There is deliberately no runtime "missing key" path: a
 * missing key is a build failure, not a silent English sentence in a
 * Turkish group.
 *
 * See MDs/multi-language-design-2026-09-16.md section 4.2.
 */
import { en } from "./strings.en";
import { tr } from "./strings.tr";
import { normaliseLang, type Lang } from "./lang";

export type Strings = typeof en;

const TABLES: Record<Lang, Strings> = { en, tr };

export function t(lang: Lang | string | null | undefined): Strings {
  return TABLES[normaliseLang(lang)];
}
