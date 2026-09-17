/**
 * Which language a group speaks, decided from what the bot can see the
 * moment it is added (the group subject and the synced history), and
 * from the first answer it gets. Deterministic, no model, no database.
 *
 * WHY DETECT RATHER THAN ASK (the self-setup flow, 2026-09-17)
 *
 * Three options were on the table for a group whose language is not
 * yet known: ask once bilingually, let the adder pick, or detect. A
 * bilingual intro doubles the words in a message the owner already
 * wants shorter, and it asks a question nobody in the group cares
 * about. Letting the adder pick needs a DM to a phone the bot often
 * cannot resolve (an @lid adder), before the group has consented to
 * anything. Detection costs zero messages and is wrong only when a
 * group's subject and recent chat give no clue, in which case English
 * is the fallback and the consent reply corrects it: "evet" flips the
 * session to Turkish before the second question is asked, "yes" flips
 * it back. So the worst case is one English intro to a Turkish group
 * that answered "evet", which is exactly the case the owner's live test
 * exercises.
 *
 * The rule is asymmetric on purpose. Turkish has letters English never
 * uses (ğ ş ı İ) and a vocabulary that never appears in an English
 * football chat, so Turkish is easy to recognise with a short list.
 * The default is English, which is what every group got before this
 * existed, so a mixed or empty picture costs nothing new.
 *
 * Every comparison lower-cases with `toLocaleLowerCase("tr")` where a
 * Turkish word is involved: "EVET" must become "evet", and a plain
 * `toLowerCase()` turns "İ" into "i̇" (i plus a combining dot), which
 * matches nothing.
 */
import type { Lang } from "./lang";

/** Letters that only Turkish uses among the languages we ship. ç, ö
 *  and ü are shared with others and are not counted. */
const TR_LETTERS = /[ğşıİĞŞ]/u;

/**
 * Turkish words a football group actually types, including the forms an
 * English keyboard produces (no special letters). Each is matched as a
 * whole token. Short function words that also occur in English ("bu",
 * "de") are left out; a false Turkish hit costs a Turkish intro to an
 * English group, which is the worse direction.
 */
const TR_WORDS = new Set([
  "varım", "varim", "var", "yokum", "yok", "geliyorum", "gelemiyorum", "gelemem",
  "evet", "hayır", "hayir", "tamam", "olur", "hadi", "abi", "kanka", "beyler",
  "maç", "mac", "maçı", "maci", "halı", "hali", "saha", "sahada", "kadro",
  "saat", "kaçta", "kacta", "kaç", "kac", "kişi", "kisi", "kişiyiz", "kisiyiz",
  "bugün", "bugun", "yarın", "yarin", "akşam", "aksam", "hafta", "haftaya",
  "pazartesi", "salı", "sali", "çarşamba", "carsamba", "perşembe", "persembe",
  "cuma", "cumartesi", "pazar", "için", "icin", "ile", "çocuklar", "cocuklar",
  "arkadaşlar", "arkadaslar", "takım", "takim", "takımlar", "takimlar", "aynı", "ayni",
  "yer", "belki", "bakarız", "bakariz", "kesin", "değil", "degil", "sayın", "sayin",
  "ben", "biz", "sen", "siz", "bize", "bana", "lazım", "lazim", "daha", "eksik",
  "oynuyoruz", "oynayalım", "oynayalim", "gidelim", "gel", "gelin", "hazır", "hazir",
  "iyi", "güzel", "guzel", "harika", "efsane", "selam", "merhaba", "teşekkürler",
  "tesekkurler", "sağol", "sagol", "sağ", "ol", "nerede", "nerde", "ne", "zaman",
]);

/**
 * English words a football group actually types. Used only so a mixed
 * chat is scored against something; the English side never needs to
 * "win", it only needs to keep a lone Turkish word from flipping the
 * language.
 */
const EN_WORDS = new Set([
  "in", "out", "im", "i'm", "the", "and", "for", "who", "who's", "whos", "we", "are",
  "this", "week", "tonight", "tomorrow", "match", "game", "pitch", "lads", "boys",
  "guys", "mate", "team", "teams", "squad", "bench", "yes", "no", "maybe", "sorry",
  "can't", "cant", "make", "it", "at", "on", "pm", "am", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday", "tues", "thurs", "weds",
  "anyone", "everyone", "still", "need", "more", "players", "goals", "kick", "off",
  "kickoff", "time", "what", "where", "when", "please", "pls", "cheers", "thanks",
]);

/** The most recent messages carry the decision; an old English era of a
 *  group that has since switched must not outvote the present. */
const HISTORY_WINDOW = 60;

export interface LangDetection {
  lang: Lang;
  /** True when the evidence pointed one way clearly; false when the
   *  fallback decided. The flow does not branch on this today; it is
   *  logged so the live test can see why the intro came out as it did. */
  confident: boolean;
  /** Human-readable, for the log. */
  reason: string;
}

function tokens(text: string): string[] {
  return text
    .toLocaleLowerCase("tr")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 0);
}

function score(text: string): { tr: number; en: number } {
  let tr = 0;
  let en = 0;
  for (const w of tokens(text)) {
    if (TR_WORDS.has(w)) tr++;
    if (EN_WORDS.has(w)) en++;
  }
  if (TR_LETTERS.test(text)) tr += 2;
  return { tr, en };
}

/**
 * Decide the group's language from its subject and its recent history.
 * The subject is weighted double (it is chosen deliberately, where a
 * message is typed in passing). Turkish needs clear evidence AND more of
 * it than English; anything else is English.
 */
export function detectGroupLang(input: {
  subject: string | null | undefined;
  history: string[];
}): LangDetection {
  const recent = input.history.slice(-HISTORY_WINDOW);
  let tr = 0;
  let en = 0;
  if (input.subject && input.subject.trim()) {
    const s = score(input.subject);
    tr += s.tr * 2;
    en += s.en * 2;
  }
  for (const m of recent) {
    const s = score(m);
    tr += s.tr;
    en += s.en;
  }
  if (tr >= 2 && tr > en) {
    return { lang: "tr", confident: true, reason: `turkish evidence ${tr} vs english ${en}` };
  }
  if (en >= 2 && en > tr) {
    return { lang: "en", confident: true, reason: `english evidence ${en} vs turkish ${tr}` };
  }
  return { lang: "en", confident: false, reason: `no clear evidence (turkish ${tr}, english ${en}), english by default` };
}

const TR_CONSENT = /^(?:evet|tamam|tamamdır|olur|hadi|tabii|tabi|tabii ki|kesinlikle|hepsi|her şey|herşey)(?:\s+lütfen)?$/u;
const EN_CONSENT = /^(?:yes|yes please|yes pls|yeah|yep|yup|everything|the lot|all of it|go for it|let'?s do it|let'?s go|sounds good)$/;

/**
 * The language of a consent reply, when the reply itself says so.
 * "evet" is Turkish whatever the group subject looked like; "yes" is
 * English. Anything that is neither (a bare "ok", an emoji) decides
 * nothing and the session keeps the language it detected.
 */
export function langOfConsentReply(raw: string): Lang | null {
  const bare = (raw ?? "")
    .trim()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[!.,…\s]+$/gu, "")
    .trim();
  if (!bare) return null;
  if (TR_CONSENT.test(bare.toLocaleLowerCase("tr"))) return "tr";
  if (EN_CONSENT.test(bare.toLowerCase())) return "en";
  return null;
}
