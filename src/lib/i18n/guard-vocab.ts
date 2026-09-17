/**
 * THE VOCABULARY THE COMPOSITION GUARDS READ, per language.
 *
 * `displaysSquadState` and `contradictsSquadState` (group-copy.ts) read
 * the bot's own output back through words: a squad header, "need N
 * more", "full squad", "N slots open", "X goes on the bench". Those are
 * English regular expressions, and a Turkish reply written by the chase
 * model ("3 kişi daha lazım", "Erdal yedeğe geçti") would sail past them
 * (design section 4.3, seam 3). This file is the same vocabulary per
 * language; the guards pick the entry for the group's language and the
 * English entry is EXACTLY the regexes the guards carried inline before
 * (moved, not edited), so English verdicts are unchanged by construction.
 *
 * Not in `strings.*.ts`: that table holds copy (strings and string
 * functions, enforced by test); these are regular expressions.
 *
 * Turkish notes:
 *   - `\p{L}` lookarounds, never `\b`: `\b` is ASCII-only and never ends
 *     on ç, ğ, ı, ö, ş, ü ("maç\b" fails).
 *   - Number words: bir, iki, üç, dört, beş; "bir" is also the article
 *     ("bir yer açıldı" = "a slot opened" = one), which is what we want.
 *   - Move claims are the shapes the Turkish table itself writes plus
 *     the ways a model paraphrases them. The list is thinner than the
 *     English one at first (the design says so); rule (a), the numbered
 *     roster, needs no words and does the heavy lifting.
 */
import type { Lang } from "./lang";

/** A capitalised word followed by letters: the thing a move claim names.
 *  `\p{Lu}`, not `[A-Z]` (2026-09-16): Ç, Ğ, İ, Ö, Ş, Ü start names too. */
export const CLAIM_NAME = "(\\p{Lu}[\\p{L}'-]+)";

export type ClaimedStatus = "CONFIRMED" | "BENCH" | "DROPPED";

export interface GuardVocab {
  /** Rule (b): a squad or bench display header. */
  headers: RegExp;
  /** Rule (c): squad vocabulary that turns an "N/M" into a count claim. */
  squadWords: RegExp;
  /** Rule (c'): a claim that the bench is empty. */
  benchEmpty: RegExp;
  /** "need N more" against the real shortfall; group 1 is the number. */
  need: RegExp;
  /** Number words `need` and `slots` may capture, lower-cased. */
  numberWords: Record<string, number>;
  /** Words that mean one when captured by `slots` (English "a", "an"). */
  oneWords: string[];
  /** "full squad", "squad is complete": a claim of no shortfall. */
  full: RegExp;
  /** "N slots open" against the real shortfall; group 1 is the number. */
  slots: RegExp;
  /** Vocabulary that makes an "N players" total a squad claim. */
  totalContext: RegExp;
  /** "N players" / "N total"; group 1 is the number. */
  total: RegExp;
  /** Announcements of a move; group 1 is the name. */
  moveClaims: Array<[RegExp, ClaimedStatus]>;
}

const TO_BENCH = "(?:on|onto|to)?\\s*(?:the\\s+)?bench";

/** English, byte for byte the patterns `group-copy.ts` carried inline. */
const en: GuardVocab = {
  headers: /\*(?:Playing\b[^*\n]*|Squad\b[^*\n]*|Confirmed\s*\(\d+\/\d+\)[^*\n]*|Bench\s*\(\d+\)[^*\n]*):?\*/i,
  squadWords: /\b(?:squad|bench|slot|full|need|player)/i,
  benchEmpty: /\bbench is empty\b/i,
  need: /\bneed\s+\*?\s*(\d+|one|two|three|four|five)\s*\*?\s+more\b/gi,
  numberWords: { one: 1, two: 2, three: 3, four: 4, five: 5 },
  oneWords: ["a", "an"],
  full: /\b(?:full\s+squad|squad\s+(?:is\s+)?(?:now\s+)?(?:complete|full|locked)|we'?re\s+(?:now\s+)?full)\b/i,
  slots: /\b(one|a|an|two|three|\d+)\s+(?:more\s+)?slots?\s+(?:still\s+)?open\b/gi,
  totalContext: /\b(?:squad|playing|turnout|confirmed|bench|lineup)\b/i,
  total: /\b(\d+)\s+(?:players?|total)\b/gi,
  moveClaims: [
    [new RegExp(`${CLAIM_NAME}\\s+(?:goes|go|is going|will go|moves|drops)\\s+${TO_BENCH}`, "giu"), "BENCH"],
    [new RegExp(`${CLAIM_NAME}\\s+is\\s+(?:now\\s+)?on\\s+the\\s+bench`, "giu"), "BENCH"],
    [new RegExp(`(?:moving|putting|benching|demoting)\\s+${CLAIM_NAME}\\b`, "giu"), "BENCH"],
    [new RegExp(`${CLAIM_NAME}\\s+is\\s+(?:now\\s+)?(?:in|confirmed|playing)\\b`, "giu"), "CONFIRMED"],
    [new RegExp(`(?:adding|added|registering|registered)\\s+${CLAIM_NAME}\\b`, "giu"), "CONFIRMED"],
    [new RegExp(`${CLAIM_NAME}\\s+is\\s+(?:now\\s+)?out\\b`, "giu"), "DROPPED"],
    [new RegExp(`(?:dropping|dropped|marking)\\s+${CLAIM_NAME}\\s+(?:as\\s+)?out\\b`, "giu"), "DROPPED"],
    // Promotion phrasings — a claim that a bench player now has a slot.
    [new RegExp(`${CLAIM_NAME}\\s+(?:moves?|comes?|steps?)\\s+(?:up|in)\\b`, "giu"), "CONFIRMED"],
    [new RegExp(`${CLAIM_NAME}\\s+(?:stepped|stepping)\\s+in\\b`, "giu"), "CONFIRMED"],
    [new RegExp(`${CLAIM_NAME}\\s+is\\s+replacing\\b`, "giu"), "CONFIRMED"],
    [new RegExp(`${CLAIM_NAME}\\s+is\\s+promoted\\b`, "giu"), "CONFIRMED"],
    [new RegExp(`(?:promoting|promoted)\\s+${CLAIM_NAME}\\b`, "giu"), "CONFIRMED"],
  ],
};

/** A Turkish word boundary: not preceded and not followed by a letter. */
const L = "(?<!\\p{L})";
const R = "(?!\\p{L})";
const TR_NUM = "(\\d+|bir|iki|üç|dört|beş)";

/** Turkish. The headers are the table's (`*Oynayanlar:*`, `*Bu akşam
 *  oynayanlar:*`, `*Yarın oynayanlar:*`, `*8 Eylül Salı oynayanlar:*`,
 *  `*Kadro:*`, `*Onaylananlar (n/m):*`, `*Yedekler (n):*`). */
const tr: GuardVocab = {
  headers: new RegExp(
    `\\*(?:[^*\\n]*?[Oo]ynayanlar[^*\\n]*|Kadro\\b[^*\\n]*|Onaylananlar\\s*\\(\\d+\\/\\d+\\)[^*\\n]*|Yedekler\\s*\\(\\d+\\)[^*\\n]*):?\\*`,
    "u",
  ),
  squadWords: new RegExp(`${L}(?:kadro|yedek|yer|lazım|kişi|eksik|oyuncu)`, "iu"),
  benchEmpty: new RegExp(`${L}(?:yedek(?:\\s+listesi)?\\s+boş|yedekte\\s+kimse\\s+yok)${R}`, "iu"),
  // "3 kişi daha lazım", "*3 kişi daha* lazım", "3 kişi daha gerek(iyor)", "3 kişi eksiğiz"
  need: new RegExp(
    `${L}\\*?\\s*${TR_NUM}\\s*\\*?\\s+kişi\\s+(?:daha\\s*\\*?\\s*(?:lazım|gerek(?:iyor|li)?)|eksi(?:ğiz|k))${R}`,
    "giu",
  ),
  numberWords: { bir: 1, iki: 2, üç: 3, dört: 4, beş: 5 },
  oneWords: [],
  full: new RegExp(`${L}(?:kadro\\s+(?:tamam|dolu|doldu|kilitlendi|tamamlandı)|dolduk|kadromuz\\s+tamam)${R}`, "iu"),
  // "bir yer açıldı", "2 yer açıldı", "2 yer boş", "2 yer açık"
  slots: new RegExp(`${L}${TR_NUM}\\s+yer\\s+(?:daha\\s+)?(?:açıldı|açık|boş)${R}`, "giu"),
  totalContext: new RegExp(`${L}(?:kadro|oynayan|onaylı|yedek)`, "iu"),
  total: new RegExp(`${L}(\\d+)\\s+(?:oyuncu|kişi)${R}`, "giu"),
  moveClaims: [
    [new RegExp(`${CLAIM_NAME}\\s+yedeğe\\s+(?:geçti|geçer|alındı|gidiyor|geçiyor|düştü)`, "giu"), "BENCH"],
    [new RegExp(`${CLAIM_NAME}\\s+(?:artık\\s+)?yedekte${R}`, "giu"), "BENCH"],
    [new RegExp(`${CLAIM_NAME}\\s+(?:artık\\s+)?kadroda${R}`, "giu"), "CONFIRMED"],
    [new RegExp(`${CLAIM_NAME}\\s+kadroya\\s+(?:eklendi|alındı|geçti|girdi)`, "giu"), "CONFIRMED"],
    [new RegExp(`${CLAIM_NAME}\\s+(?:onaylandı|geliyor|eklendi)${R}`, "giu"), "CONFIRMED"],
    [new RegExp(`${CLAIM_NAME}\\s+(?:çıktı|çıkarıldı|gelmiyor|ayrıldı|kadrodan\\s+(?:çıktı|çıkarıldı|düştü))${R}`, "giu"), "DROPPED"],
    // Promotion phrasings: a bench player now has a slot.
    [new RegExp(`${CLAIM_NAME}\\s+(?:yedekten\\s+)?(?:kadroya\\s+)?(?:yükseldi|çıktı\\s+kadroya|yerine\\s+(?:geçti|giriyor|oynuyor))`, "giu"), "CONFIRMED"],
  ],
};

export const GUARD_VOCAB: Record<Lang, GuardVocab> = { en, tr };
