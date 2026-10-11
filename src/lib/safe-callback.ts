/**
 * Where a sign-in may send somebody afterwards.
 *
 * `/login?callbackUrl=` is whatever the link says, and anyone can hand an
 * organiser a link. So it is followed only when it is a path on this
 * site: it starts with exactly one "/", and holds no backslash (browsers
 * read "/\host" as "//host") and no control character (browsers strip
 * tabs and newlines out of a URL, so "/\t/host" is "//host" too).
 *
 * Pure, so the rule is unit tested without a request.
 */
const MAX_LENGTH = 512;

export function safeCallbackPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}
