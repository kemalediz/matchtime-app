/**
 * Normalise a user-entered phone number to STRICT E.164 (`+CC…digits`).
 *
 * Output guarantees (so canonicalisation is total):
 *  - Always starts with `+`.
 *  - 7–15 digits after `+`, first digit 1-9 (no leading 0).
 *  - Returns `null` if the input can't be coerced to that shape.
 *
 * Input handling:
 *  - Strips bidi-formatting control characters (U+200E, U+200F,
 *    U+202A–U+202E) that sneak in when copying from WhatsApp / iOS
 *    contacts. These are invisible but break equality.
 *  - Strips whitespace, dashes, parens.
 *  - "00…" → "+…" (international dialing prefix).
 *  - "07XXXXXXXXX" → "+44XXXXXXXXX" (UK local mobile).
 *  - "447XXXXXXXXX" (UK no `+`, as WhatsApp sends JIDs) → "+447XXXXXXXXX".
 *  - Anything else without a leading `+` → null (force callers to be
 *    explicit about country code rather than guessing).
 *
 * This function is the SOLE source-of-truth for phone canonicalisation.
 * Every Prisma write of `User.phoneNumber` goes through the auto-norm
 * extension in `src/lib/db.ts`, which calls this. Don't bypass.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip bidi marks, whitespace, dashes, parens.
  let s = raw.replace(/[‎‏‪-‮\s\-()]/g, "").trim();
  if (!s) return null;

  // International dialing prefix "00…" → "+…"
  if (s.startsWith("00")) s = "+" + s.slice(2);
  // UK local mobile "07XXXXXXXXX" (11 chars) → "+44XXXXXXXXX"
  else if (/^07\d{9}$/.test(s)) s = "+44" + s.slice(1);
  // UK no-`+` (as WhatsApp JIDs arrive: "447XXXXXXXXX") → "+447XXXXXXXXX"
  // Treat any 12-digit string starting with "44" as UK (covers historic
  // bot-side strings stored without `+`).
  else if (/^44\d{10}$/.test(s)) s = "+" + s;

  // Final pass: must now be `+` followed by 7–15 digits, no leading 0.
  // Anything else is rejected to avoid silently storing garbage.
  if (!s.startsWith("+")) return null;
  const digits = s.slice(1).replace(/\D/g, "");
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  return "+" + digits;
}
