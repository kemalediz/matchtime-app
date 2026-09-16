/**
 * THE ENGLISH STRING TABLE, and the TYPE every other language must satisfy.
 *
 * `type Strings = typeof en` (in ./t.ts). `strings.tr.ts` is declared
 * `const tr: Strings`, so a key missing from Turkish is a `tsc` error and
 * the build fails. That is the "missing key fails the build" rule, with
 * no runtime machinery.
 *
 * Every entry with parameters is a FUNCTION `(p) => string`, never a
 * `"{name}"` interpolation string. Turkish attaches case suffixes to the
 * thing it names ("Salı'ya", "Sim Arena'da") and vowel harmony decides
 * the suffix, so a placeholder dropped into a fixed sentence is wrong for
 * half the venues and names. A function lets the native speaker write
 * the sentence so the interpolated value sits in a suffix-free position.
 *
 * ── PHASE 0: THE MECHANISM ONLY ─────────────────────────────────────
 *
 * This table holds ONE probe entry. No existing string has been moved
 * here yet: that is Phase 2's job, one composer at a time, with
 * `__tests__/copy-golden.test.ts` proving every English byte identical
 * before and after each move. Moving a string is a refactor of the
 * composer that owns it, reviewed as such, never a drive-by.
 *
 * ── WHEN YOU ADD AN ENTRY (Phase 2 onwards) ─────────────────────────
 *
 *   - WhatsApp formatting, not markdown: `*bold*`, no headings.
 *   - Keep the emoji the English copy uses, in the same positions.
 *   - No time-of-day greeting and no send-time stamp
 *     (`no-time-of-day-greeting.test.ts` scans this directory too).
 *   - The English wording is moved BYTE FOR BYTE. If the current English
 *     contains an em dash, it keeps it: the golden snapshot decides,
 *     not house style. Cleaning it up is a separate, visible change.
 *
 * See MDs/multi-language-design-2026-09-16.md section 4.2.
 */

export const en = {
  /**
   * The one entry that proves the mechanism is wired: `t(lang)` resolves
   * a table, the table's keys are typed, and a parameterised entry is a
   * function. Not used by any composer. Remove it once a real entry
   * exists, or keep it as the canary; either is fine.
   */
  probe: (p: { name: string }): string => `Hello ${p.name}, this is MatchTime.`,
};
