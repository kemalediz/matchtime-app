/**
 * WHEN A WHATSAPP NAME MAY BECOME A PLAYER'S NAME. Pure, no db.
 *
 * Moved out of `resolve-sender.ts` on 2026-11-16 so `pipeline/mention-names.ts`
 * (pure) applies the very same rule when it names a nameless member from
 * the WhatsApp name a batch carried. `resolve-sender.ts` re-exports both.
 */

/**
 * True when a "name" is really a raw phone number / numeric @lid id
 * ("447700900123", "123456789012@lid", "+44 7700 900123", "@4477…").
 * Never stamp these as display names or print them in group posts —
 * use a neutral placeholder and let an admin rename. (RC4 of the
 * 2026-06-12 Sutton Lads incident: a bare number showed up as a player
 * name in a group post.)
 */
export function isRawDigitName(raw: string): boolean {
  const cleaned = raw
    .trim()
    .replace(/@?lid$/i, "")
    .replace(/[@\s+().-]/g, "");
  return /^\d{5,}$/.test(cleaned);
}
/**
 * A WhatsApp display name fit to become a player's name, or null: trimmed,
 * 2 to 60 characters, not a raw number (RC4, see `isRawDigitName`), not
 * the bot or a system author. Used for a nameless placeholder's first
 * post and for a joiner the Pi could name (2026-09-30).
 */
export function usableWhatsAppName(raw: string | null | undefined): string | null {
  const name = raw?.trim().replace(/\s+/g, " ") ?? "";
  if (name.length < 2 || name.length > 60) return null;
  if (isRawDigitName(name)) return null;
  if (/^(match ?time|whatsapp|system)$/i.test(name)) return null;
  return name;
}
