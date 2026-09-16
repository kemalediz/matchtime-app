/**
 * THE TURKISH STRING TABLE. The owner (a native speaker) reviews THIS
 * file, and only this file, when Turkish copy changes.
 *
 * ── PHASE 0: NOTHING IS TRANSLATED YET ──────────────────────────────
 *
 * Every key is present (the `: Strings` annotation makes a missing one a
 * `tsc` error) and every entry is the English one, wrapped in
 * `untranslated()` so a grep for `untranslated(` lists exactly what is
 * still owed. The owner writes the Turkish in Phase 2; nothing in this
 * file is a translation and nothing here is reviewed as one.
 *
 * ── CONVENTIONS FOR THE TURKISH (from the design, section 4.4) ──────
 *
 *   - WhatsApp formatting, not markdown: bold is `*single asterisks*`,
 *     no headings, no backticks except for literal commands the user
 *     should type (`swap X Y` stays a backtick because it is typed).
 *   - Keep the emoji the English copy uses in the same positions
 *     (📋, 🙏, ✅, 🥁, ⚽, 🪑); the group learns them once and they are
 *     language-free.
 *   - Register: warm-informal. "sen" in DMs (one person to one person),
 *     plural imperatives in the group ("yazın", "haber verin"). No
 *     "abi", no "beyler": that is the players' register with each
 *     other, and it assumes a gender the roster may not have.
 *   - Interpolated values (names, venues, dates, counts) sit where
 *     Turkish needs no suffix on them: "Yer: Sim Arena", "Maç: Salı 15
 *     Eylül", not "Sim Arena'da". Where a suffix is unavoidable the
 *     function computes it from the last vowel (a small, tested helper),
 *     never a fixed guess.
 *   - No time-of-day greeting and no send-time stamp: no "Günaydın",
 *     "İyi akşamlar", "17:00 güncellemesi".
 *   - No em dashes and no en dashes (house style; the hygiene test in
 *     `__tests__/strings.test.ts` enforces it for this file).
 *   - Dotted and dotless i: any lower-casing of Turkish text for
 *     matching must use `toLocaleLowerCase("tr")`.
 *
 * See MDs/multi-language-design-2026-09-16.md sections 4.2 and 4.4.
 */
import { en } from "./strings.en";
import type { Strings } from "./t";

/**
 * Marks an entry that still returns the English. It changes nothing at
 * runtime; it exists so the unfinished entries are greppable and so a
 * reviewer can see at a glance which lines carry real Turkish.
 */
function untranslated<T>(entry: T): T {
  return entry;
}

export const tr: Strings = {
  probe: untranslated(en.probe),
};
