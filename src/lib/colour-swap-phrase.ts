/**
 * THE COLOUR-SWAP PHRASE, as a pure function of the message body.
 *
 * "swap the colours", "flip red and yellow": the two SIDES change
 * colour, the line-ups do not move. `api/whatsapp/analyze/route.ts`'s
 * `handleColorSwapIfApplicable` owns it on the RAW BODY before any
 * model runs, and the clause peel uses the same test to choose WHICH
 * clause of a compound message is the colour swap, without a database
 * read. One definition, so the peel can never disagree with the handler
 * about what a colour swap looks like.
 *
 * Lifted out of `route.ts` on 2026-09-17 when the Turkish forms went
 * in: a private helper in a 4,000-line route file had no test of its
 * own, and a regex over two languages needs one
 * (`__tests__/colour-swap-phrase.test.ts`).
 *
 * ── TURKISH ──────────────────────────────────────────────────────────
 *
 * The typed form the Turkish string table quotes is "renkleri
 * değiştir" (swap the colours); the labels a Turkish org is shown are
 * "Kırmızı" / "Sarı" (`team-labels.ts`), so "kırmızıyla sarıyı
 * değiştir" is the second form, with whatever suffix the sentence
 * needs. Notes:
 *
 *   - `\p{L}` lookbehinds, never `\b`: `\b` is ASCII-only and would
 *     match INSIDE "kırmızıyla" (ı is not a `\w`).
 *   - The body is lower-cased with plain `toLowerCase()` and the
 *     patterns tolerate what that does to Turkish capitals: "İ"
 *     becomes "i" + U+0307, "I" becomes "i" (so a dotless ı typed as a
 *     plain i from an English keyboard reads the same), "Ş" becomes
 *     "ş". `toLocaleLowerCase("tr")` was NOT used because it would turn
 *     an English "I" into "ı" and the English regexes run on the same
 *     string.
 *   - The English regexes are byte-identical to the ones that shipped;
 *     the Turkish ones are OR-ed after them, so an English verdict
 *     cannot change.
 */

/** The Turkish swap verbs: değiştir(in), değişsin, ters çevir, takas.
 *  ASCII-typed "degistir" reads the same. */
const TR_VERB = String.raw`(?<!\p{L})(?:de[ğg]i̇?[şs]\p{L}*|ters\s+[çc]evir\p{L}*|[çc]evir\p{L}*|takas\p{L}*)`;
/** "renk", with any suffix: renkler, renkleri, renklerini. */
const TR_COLOUR_WORD = String.raw`(?<!\p{L})renk\p{L}*`;
/** Either default Turkish label, with any suffix, dotless ı or plain i. */
const TR_LABEL = String.raw`(?<!\p{L})(?:k[ıi]rm[ıi]z[ıi]|sar[ıi])\p{L}*`;

const TR_COLOUR_SWAP = new RegExp(`${TR_COLOUR_WORD}[\\s\\S]{0,40}?${TR_VERB}`, "u");
const TR_LABEL_SWAP = new RegExp(`${TR_LABEL}[\\s\\S]{0,25}?${TR_LABEL}[\\s\\S]{0,25}?${TR_VERB}`, "u");
const TR_HAS_VERB = new RegExp(TR_VERB, "u");

/**
 * Does the message carry a swap verb at all, in either language? The
 * handler's cheap pre-gate: without one it never spends a query on the
 * custom-label check.
 */
export function hasSwapVerb(rawBody: string): boolean {
  const body = (rawBody || "").trim();
  return /\b(swap|switch|flip|reverse|invert|change)\b/i.test(body) || TR_HAS_VERB.test(body.toLowerCase());
}

/**
 * The LITERAL-colour half of the colour-swap detection: "swap/flip the
 * colours", "swap red and yellow", "renkleri değiştir", "kırmızıyla
 * sarıyı değiştir". No database, no org labels, no `await`.
 *
 * It is deliberately NOT the whole test: an org with custom team labels
 * ("swap the Bibs and the Skins") is recognised only inside the
 * handler, where the match row says what this org calls its sides
 * (`looksLikeLabelSwapPhrase`). When this returns false the peel hands
 * the handler the WHOLE body, so that branch is reached exactly as it
 * was before clause peeling existed.
 */
export function looksLikeColourSwapPhrase(rawBody: string): boolean {
  const body = (rawBody || "").trim();
  if (
    /\b(swap|switch|flip|reverse|invert|change)\b[\s\S]{0,40}\bcolou?rs?\b/i.test(body) ||
    /\bcolou?rs?\b[\s\S]{0,40}\b(swap|switch|flip|reverse|invert|change)\b/i.test(body) ||
    /\bswap\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b/i.test(body)
  ) {
    return true;
  }
  const lower = body.toLowerCase();
  return TR_COLOUR_SWAP.test(lower) || TR_LABEL_SWAP.test(lower);
}

/**
 * The custom-label half: "swap <labelA> and <labelB>" for THIS org's
 * two configured labels, in either order, English verb-first or
 * Turkish verb-last. Red/Yellow (and Kırmızı/Sarı) are already covered
 * by `looksLikeColourSwapPhrase`; the caller filters them out of
 * `labels` before asking, exactly as it did when this lived inline.
 * Returns false unless exactly two labels are given.
 */
export function looksLikeLabelSwapPhrase(rawBody: string, labels: readonly string[]): boolean {
  const alts = labels
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (alts.length !== 2) return false;
  const alt = `(?:${alts.join("|")})`;
  const body = (rawBody || "").trim();
  const english = new RegExp(`\\bswap\\b[\\s\\S]{0,25}${alt}[\\s\\S]{0,25}${alt}`, "i");
  if (english.test(body)) return true;
  const turkish = new RegExp(`${alt}\\p{L}*[\\s\\S]{0,25}?${alt}\\p{L}*[\\s\\S]{0,25}?${TR_VERB}`, "iu");
  return turkish.test(body.toLowerCase());
}
