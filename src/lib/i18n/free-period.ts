/**
 * HOW LONG A NEW CLUB IS FREE, IN WORDS. CLIENT-SAFE and pure.
 *
 * The length is `FREE_PERIOD_MONTHS` in club-billing-rules.ts, the same
 * constant the date arithmetic uses (`freePeriodEnd`). Every sentence that
 * states the length is built here from that number, so the copy cannot say
 * one thing while the billing does another: the "you're live" DM, the
 * public website, the help pages and the platform owner's page.
 *
 * Sentences that only REFER to the period ("the free period ends on ...")
 * carry no number and live in the string tables as usual.
 *
 * No em dashes and no en dashes (house style).
 */
import { FREE_PERIOD_MONTHS } from "../club-billing-rules";
import type { Lang } from "./lang";

const WORDS: Record<Lang, readonly string[]> = {
  en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"],
  tr: ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "on bir", "on iki"],
};

/** The number as a word ("two", "iki"); digits above twelve. */
function numberWord(lang: Lang, n: number): string {
  return WORDS[lang][n] ?? String(n);
}

/** "three months" / "üç ay" (Turkish takes no plural after a number). */
export function freePeriodLength(lang: Lang, months: number = FREE_PERIOD_MONTHS): string {
  if (lang === "tr") return `${numberWord("tr", months)} ay`;
  return `${numberWord("en", months)} ${months === 1 ? "month" : "months"}`;
}

/**
 * "Your first three months are free" / "İlk üç ayınız ücretsiz", with NO
 * full stop, so a caller can end the sentence or carry it on.
 */
export function firstMonthsFree(lang: Lang, months: number = FREE_PERIOD_MONTHS): string {
  if (lang === "tr") return months === 1 ? "İlk ayınız ücretsiz" : `İlk ${numberWord("tr", months)} ayınız ücretsiz`;
  return months === 1 ? "Your first month is free" : `Your first ${numberWord("en", months)} months are free`;
}

/** The public website's pricing badge: "First three months free" (English;
 *  the website is English only). */
export function firstMonthsFreeBadge(months: number = FREE_PERIOD_MONTHS): string {
  return months === 1 ? "First month free" : `First ${numberWord("en", months)} months free`;
}
