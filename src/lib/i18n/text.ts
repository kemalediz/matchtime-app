/**
 * Per-language TEXT helpers that are grammar rather than copy: things
 * a string table cannot hold because they take a list.
 *
 * Pure. No clock, no database.
 */
import { normaliseLang, type Lang } from "./lang";

/**
 * "A, B and C" / "A, B ve C". The English form is `compose.ts`'s
 * `joinList` byte for byte (no Oxford comma); the "+" and "&" house
 * styles elsewhere (`format-switch.ts`, `mom-announcement.ts`) are
 * language-free and are not this function's business.
 */
export function joinList(lang: Lang | string | null | undefined, names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  const and = normaliseLang(lang) === "tr" ? "ve" : "and";
  return `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}
