/**
 * "swap/switch/flip the colours", "swap colors", "swap red and yellow":
 * a request to flip the team LABELS while keeping the exact same player
 * groupings.
 *
 * The LITERAL-colour half of the colour-swap detection. No database, no
 * org labels, no `await`, which is the whole reason it is a function of
 * its own: the clause peel in `api/whatsapp/analyze/route.ts` needs to
 * choose WHICH clause of a message the colour swap belongs to before it
 * decides whether to spend a query at all. `handleColorSwapIfApplicable`
 * calls this too, so there is one definition and the peel can never
 * disagree with the handler about what a colour swap looks like.
 *
 * It is deliberately NOT the whole test: an org with custom team labels
 * ("swap the Bibs and the Skins") is recognised by
 * `looksLikeLabelSwapPhrase`, inside the handler, where the match row
 * says what this org calls its sides.
 *
 * Moved here from `route.ts` on 2026-09-17 so it can be unit tested and
 * read by `scripts/dryrun-pipeline.ts`. The English regexes are the
 * shipped ones, byte for byte.
 *
 * ── TURKISH (2026-09-17) ─────────────────────────────────────────────
 *
 * The Turkish copy tells a group to type "@Match Time renkleri
 * değiştir", and a Turkish org's default labels are Kırmızı / Sarı
 * (`team-labels.ts`). Measured before this existed: the teams extractor
 * read "renkleri değiştir" as `rename` 10 of 10 (the English "swap the
 * colors" reads the same way), which is handed back, so the group heard
 * nothing. A colour swap is the one team edit that must never reach the
 * model, because the model's nearest neighbour is a regenerate.
 *
 * Matched on the Turkish lower-case (`toLocaleLowerCase("tr")`, so a
 * typed "İ" and "I" fold the Turkish way), with `[ıi]`, `[gğ]`, `[sş]`,
 * `[çc]` so the same words typed from an English keyboard still match.
 * JavaScript's `\b` is ASCII-only, so word edges are `(?<!\p{L})` /
 * `(?!\p{L})`. The verb has a closed list of endings and NOT the
 * negative "değiştirme" ("do not change"), which would otherwise flip a
 * sheet somebody asked to keep.
 */
export function looksLikeColourSwapPhrase(rawBody: string): boolean {
  const body = (rawBody || "").trim();
  return (
    /\b(swap|switch|flip|reverse|invert|change)\b[\s\S]{0,40}\bcolou?rs?\b/i.test(body) ||
    /\bcolou?rs?\b[\s\S]{0,40}\b(swap|switch|flip|reverse|invert|change)\b/i.test(body) ||
    /\bswap\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b[\s\S]{0,25}\b(red|yellow|reds|yellows)\b/i.test(body) ||
    looksLikeTurkishColourSwap(body)
  );
}

/** "değiştir", "değiştirin", "değiştirir misin", "değiştirebilir
 *  misin", "değiştirelim", "değiştirsene", "ters çevir". Never
 *  "değiştirme". */
export const TR_SWAP_VERB =
  "(?:de[gğ]i[sş]tir(?:in|elim|sene|ir\\s+misin|ebilir\\s+misin)?|ters\\s+[çc]evir(?:in)?)(?!\\p{L})";

const TR_RED = "k[ıi]rm[ıi]z[ıi]";
const TR_YELLOW = "sar[ıi]";
/** A colour word with an optional case ending, with or without the
 *  apostrophe: "kırmızı", "kırmızıyla", "Sarı'yı", "sarıyı". */
const trColour = (stem: string) => `(?<!\\p{L})${stem}(?:['’]?\\p{L}{0,4})?`;
const TR_COLOUR_SWAP = [
  // "renkleri değiştir", "renkleri ters çevir".
  new RegExp(`(?<!\\p{L})renk(?:ler)?(?:i|ini)?\\s+${TR_SWAP_VERB}`, "u"),
  // "kırmızıyla sarıyı değiştir", "Kırmızı ile Sarı'yı değiştir",
  // "KIRMIZI ve SARI takımları değiştir", in either order.
  ...[
    [TR_RED, TR_YELLOW],
    [TR_YELLOW, TR_RED],
  ].map(
    ([a, b]) =>
      new RegExp(
        `${trColour(a)}\\s+(?:(?:ile|ve)\\s+)?${trColour(b)}\\s+(?:takımları\\s+|takimlari\\s+)?${TR_SWAP_VERB}`,
        "u",
      ),
  ),
];

function looksLikeTurkishColourSwap(body: string): boolean {
  const lower = body.toLocaleLowerCase("tr");
  return TR_COLOUR_SWAP.some((re) => re.test(lower));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * "swap <labelA> and <labelB>" with THIS org's own labels, in English or
 * Turkish ("<labelA> ile <labelB>'yi değiştir"). Red / Yellow are
 * skipped: `looksLikeColourSwapPhrase` owns them. Needs exactly two
 * labels, which is why it cannot run before the match row is read.
 */
export function looksLikeLabelSwapPhrase(rawBody: string, labels: readonly string[]): boolean {
  const body = (rawBody || "").trim();
  const kept = labels.map((l) => l.trim()).filter((l) => l && !/^(red|yellow)$/i.test(l));
  if (kept.length !== 2) return false;
  const alt = `(?:${kept.map(escapeRe).join("|")})`;
  // The shipped English form, unchanged.
  if (new RegExp(`\\bswap\\b[\\s\\S]{0,25}${alt}[\\s\\S]{0,25}${alt}`, "i").test(body)) return true;
  const lower = body.toLocaleLowerCase("tr");
  const altTr = `(?:${kept.map((l) => escapeRe(l.toLocaleLowerCase("tr"))).join("|")})`;
  return new RegExp(
    `(?<!\\p{L})${altTr}(?:['’]?\\p{L}{0,4})?\\s+(?:(?:ile|ve)\\s+)?${altTr}(?:['’]?\\p{L}{0,4})?\\s+${TR_SWAP_VERB}`,
    "u",
  ).test(lower);
}
