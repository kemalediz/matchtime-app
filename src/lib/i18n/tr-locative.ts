/**
 * The Turkish locative ending ("-da, -de, -ta, -te") after a number written
 * in digits: "09:00'da", "28 Eki 2026'da". The ending follows the LAST WORD
 * the number is read with: "dokuz" (09:00) takes 'da, "on bir" (11:00) 'de,
 * "on üç" (13:00) 'te, "iki bin yirmi altı" (2026) 'da. A time is read as
 * its hour, then its minutes when there are any ("dokuz otuz").
 *
 * The house rule (strings.tr.ts) is to place values where Turkish needs no
 * suffix; this small helper is for the few lines where one is unavoidable.
 * Pure. Unit tested in `__tests__/tr-locative.test.ts`.
 */

// The ending each last word takes: vowel harmony from its last vowel,
// a hard "t" after f, s, t, k, ç, ş, h, p.
const UNITS = ["da", "de", "de", "te", "te", "te", "da", "de", "de", "da"]; // sıfır bir iki üç dört beş altı yedi sekiz dokuz
const TENS = ["", "da", "de", "da", "ta", "de", "ta", "te", "de", "da"]; // on yirmi otuz kırk elli altmış yetmiş seksen doksan

function endingOf(n: number): string {
  if (n === 0) return UNITS[0];
  if (n % 10 !== 0) return UNITS[n % 10];
  if (n % 100 !== 0) return TENS[(n % 100) / 10];
  return "de"; // yüz, bin
}

export function trLocative(text: string): string {
  const time = /(\d{1,2}):(\d{2})$/.exec(text);
  if (time) {
    const minutes = Number(time[2]);
    return `${text}'${endingOf(minutes !== 0 ? minutes : Number(time[1]))}`;
  }
  const num = /(\d+)$/.exec(text);
  if (num) return `${text}'${endingOf(Number(num[1]))}`;
  return text;
}
