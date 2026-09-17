/**
 * Pure parsing logic for the autonomous onboarding flow (Phase 1,
 * 2026-06-12 design — MDs/autonomous-onboarding-design-2026-06-12.md).
 *
 * NO imports of db / Anthropic / Next — everything in here is a pure
 * function over strings, so it's unit-testable without a database and
 * usable from both the conversation state machine and the test suites.
 *
 * Codebase principle: "LLM for understanding, deterministic code for
 * control". These functions ARE the deterministic control layer — the
 * LLM only ever backfills what they miss.
 */
import { FEATURE_META, type ToggleableKey } from "./org-features-meta";
import { normalisePhone } from "./phone";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

// ─────────────────────────── session lifecycle ─────────────────────────

/** The stages during which a session owns its group's messages. One
 *  list, read by the analyze route, the bot-added route and the orgs
 *  route: the Pi's restart list used to omit "admins", so a restart
 *  during the admins question silently dropped the group. */
export const ACTIVE_ONBOARDING_STAGES = [
  "introduced",
  "admins",
  "details",
  "collecting",
  "features",
] as const;

/** A session older than this is stale: it stops owning the group, the
 *  bot-added route starts a fresh one on the next add, and a live org
 *  set up any other way is never shadowed by it. Measured from
 *  creation, not from the last write: at the `introduced` stage every
 *  ordinary chat message bumps `updatedAt` (lastHandledWaId), so a
 *  group that never consents but keeps chatting would otherwise never
 *  go stale. */
export const ONBOARDING_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function isOnboardingSessionStale(
  s: { createdAt: Date },
  now: Date = new Date(),
): boolean {
  return now.getTime() - s.createdAt.getTime() > ONBOARDING_SESSION_TTL_MS;
}

/** Lower-case for matching Turkish: "EVET" must become "evet" and "İ"
 *  must become "i", which a plain toLowerCase() gets wrong. */
function trLower(s: string): string {
  return (s ?? "").toLocaleLowerCase("tr").replace(/’/g, "'");
}

// ─────────────────────────── feature bundles ───────────────────────────

/** The "YES" bundle — the recommended setup the intro message offers.
 *  Everything except payment tracking (the most common carve-out).
 *  statsQa is excluded from the LIST because completion flips it on
 *  unconditionally anyway (Kemal 2026-05-29: always on). */
export const RECOMMENDED_BUNDLE: ToggleableKey[] = [
  "attendance",
  "bench",
  "teamBalancing",
  "momVoting",
  "playerRating",
  "reminders",
];

/** The "EVERYTHING" bundle — recommended + payment tracking + statsQa.
 *  `paymentCollection` (Stripe) is deliberately NEVER chat-set: it
 *  requires a connected bank, which the dashboard owns. */
export const EVERYTHING_BUNDLE: ToggleableKey[] = [
  ...RECOMMENDED_BUNDLE,
  "statsQa",
  "paymentTracking",
];

export interface BundleChoice {
  choice: "yes" | "everything" | "custom";
  features: ToggleableKey[];
}

/** Standalone-affirmative matcher. Deliberately strict (short message,
 *  nothing but the affirmative + punctuation/emoji) so a "yes" buried in
 *  normal chat ("yes mate what a game") can never trigger setup. */
const YES_RE =
  /^(yes|yes please|yes pls|yess+|yeah|yep|yup|go for it|let'?s do it|let'?s go|sounds good|count us in|sign us up|yes go)$/i;

/** Feature keywords → canonical keys. Mirrors the legacy feature-menu
 *  regex in regexExtract, minus numbered picks (the group-add intro has
 *  no numbered menu, and bare digits in chat are noise). */
function pickFeatureKeywords(t: string): ToggleableKey[] {
  const picked = new Set<ToggleableKey>();
  if (/\b(mom|man of the match|motm)\b/.test(t)) picked.add("momVoting");
  if (/\b(rating|ratings|rate)\b/.test(t)) picked.add("playerRating");
  if (/\b(attendance|in\/out|squad list|squad)\b/.test(t)) picked.add("attendance");
  if (/\bbench\b/.test(t)) picked.add("bench");
  if (/\b(fair teams?|balanc|team generation|teams)\b/.test(t)) picked.add("teamBalancing");
  if (/\b(reminders?|remind)\b/.test(t)) picked.add("reminders");
  if (/\b(stats|history|leaderboard)\b/.test(t)) picked.add("statsQa");
  if (/\bpay(ment)?s?( tracking)?\b/.test(t)) picked.add("paymentTracking");
  return [...picked];
}

/**
 * Parse a consent/bundle reply at the `introduced` stage.
 *
 * Returns null when the message is NOT a setup answer (ordinary group
 * chat) — the bot stays silent, per the falls-open principle.
 *
 *  - "YES" (standalone)            → recommended bundle
 *  - "EVERYTHING" / "the lot"      → everything incl. payment tracking
 *  - "everything except payments"  → everything minus paymentTracking
 *  - named subset ("just MoM and ratings") → those features. Guarded:
 *    needs an explicit selection cue OR ≥2 distinct feature keywords,
 *    so incidental words ("nice teams lads") can't start setup.
 */
export function parseBundleReply(raw: string): BundleChoice | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t) return null;

  // Strip trailing punctuation/emoji for the standalone-YES check.
  const bare = t
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[!.,…\s]+$/g, "")
    .trim();
  if (bare.length <= 30 && YES_RE.test(bare)) {
    return { choice: "yes", features: [...RECOMMENDED_BUNDLE] };
  }

  // The same three shapes in Turkish (2026-09-17). Matched on the
  // Turkish lower-casing, before the English EVERYTHING / subset checks,
  // so "hepsi" and "sadece maçın adamı" are read as what they are.
  const tr = parseBundleReplyTr(raw);
  if (tr) return tr;

  // EVERYTHING (kept reasonably short so "we talked about everything
  // last night" in a long chat message can't trigger).
  if (t.length <= 120 && /\b(everything|the lot|all of (?:it|them)|all features)\b/.test(t)) {
    let features = [...EVERYTHING_BUNDLE];
    if (/\b(except|but not|apart from|without|minus|no)\b[^.]*\bpay/.test(t)) {
      features = features.filter((k) => k !== "paymentTracking");
    }
    return { choice: "everything", features };
  }

  // Named subset.
  const picks = pickFeatureKeywords(t);
  if (picks.length === 0) return null;
  const cue =
    /\b(just|only|want|we'?d like|give us|enable|turn on|switch on|set ?up|start with|go with|please)\b/.test(t);
  if ((cue || picks.length >= 2) && t.length <= 200) {
    return { choice: "custom", features: picks };
  }
  return null;
}

// ── the same consent shapes in Turkish ─────────────────────────────────

/** Standalone Turkish affirmatives, whole-string on the cleaned text. */
const YES_RE_TR =
  /^(?:evet|evet lütfen|evet lutfen|evet evet|tamam|tamamdır|tamamdir|olur|olur olur|hadi|tabii|tabi|tabii ki|tabi ki|kesinlikle|yapalım|yapalim|başlayalım|baslayalim|kuralım|kuralim|kur|aynen)$/u;

/** "hepsi" / "her şey" and the payment carve-out. */
const EVERYTHING_RE_TR = /(?<!\p{L})(?:hepsi|hepsini|her şey|herşey|her sey|hersey|tamamı|tamami|tümü|tumu)(?!\p{L})/u;
const EXCEPT_PAY_RE_TR =
  /(?:ödeme|odeme|para)\p{L}*\s*(?:hariç|haric|olmasın|olmasin|yok|dışında|disinda|istemiyoruz)|ödemesiz|odemesiz|(?:hariç|haric)\s*\p{L}*\s*(?:ödeme|odeme)/u;

function pickFeatureKeywordsTr(t: string): ToggleableKey[] {
  const picked = new Set<ToggleableKey>();
  const has = (re: RegExp) => re.test(t);
  if (has(/maçın adamı|macin adami|maç adamı|mac adami|(?<!\p{L})mom(?!\p{L})/u)) picked.add("momVoting");
  if (has(/puanlama|puanlar|(?<!\p{L})puan(?!\p{L})|oylama|değerlendirme|degerlendirme/u)) picked.add("playerRating");
  if (has(/yoklama|katılım|katilim|(?<!\p{L})kadro(?!\p{L})|kadro listesi/u)) picked.add("attendance");
  if (has(/(?<!\p{L})yedek/u)) picked.add("bench");
  if (has(/(?<!\p{L})takım|(?<!\p{L})takim|denge/u)) picked.add("teamBalancing");
  if (has(/hatırlat|hatirlat/u)) picked.add("reminders");
  if (has(/istatistik|geçmiş|gecmis|sıralama|siralama/u)) picked.add("statsQa");
  if (has(/(?<!\p{L})ödeme|(?<!\p{L})odeme|(?<!\p{L})para(?!\p{L})|ücret|ucret/u)) picked.add("paymentTracking");
  return [...picked];
}

function parseBundleReplyTr(raw: string): BundleChoice | null {
  const t = trLower(raw).trim();
  if (!t) return null;
  const bare = t
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[!.,…\s]+$/gu, "")
    .trim();
  if (bare.length <= 30 && YES_RE_TR.test(bare)) {
    return { choice: "yes", features: [...RECOMMENDED_BUNDLE] };
  }
  if (t.length <= 120 && EVERYTHING_RE_TR.test(t)) {
    let features = [...EVERYTHING_BUNDLE];
    if (EXCEPT_PAY_RE_TR.test(t)) features = features.filter((k) => k !== "paymentTracking");
    return { choice: "everything", features };
  }
  const picks = pickFeatureKeywordsTr(t);
  if (picks.length === 0) return null;
  const cue =
    /(?<!\p{L})(?:sadece|sade|yeter|istiyoruz|istiyorum|isteriz|aç|açalım|acalim|olsun|lütfen|lutfen|kur|kuralım|kuralim)(?!\p{L})/u.test(t);
  if ((cue || picks.length >= 2) && t.length <= 200) {
    return { choice: "custom", features: picks };
  }
  return null;
}

// ─────────────────────────── admins parsing ────────────────────────────

export interface ParsedAdmin {
  /** Display name if a name was given (null for a bare phone/mention). */
  name: string | null;
  /** Phone as EXTRACTED — a cleaned digit/`+` string, NOT E.164. The
   *  conversation/DB layer calls normalisePhone() on it. null when only
   *  a name or an unusable @lid mention was given. */
  phone: string | null;
  /** The raw "@<digits>" mention token if the entry came from a mention. */
  mention: string | null;
}

export interface AdminsParse {
  admins: ParsedAdmin[];
  /** True for "just me"/"only me"/"nobody else" style answers — the owner
   *  already covers admin, so `admins` is empty. */
  justMe: boolean;
}

/** "Just me / nobody else" answers — the owner is already the admin, so
 *  there are no ADDITIONAL admins to capture. Strict whole-string match
 *  on the cleaned (lowercased, punctuation/emoji-stripped) text. */
const JUST_ME_RE =
  /^(just me|only me|me only|just us|only us|just myself|no ?one(?: else)?|nobody(?: else)?|none|nope|no thanks?|me|myself|i(?:'| a)?m the (?:only )?admin|i'?ll do it|i will do it|i'?ll handle it|i'?m it|it'?s (?:just )?me|im the only one)( (?:thanks?|cheers|please|pls|ta|mate|for now))?$/i;

/** Common chat interjections / filler that are NOT names — keeps a junk
 *  one-liner ("lol", "idk really") from being mistaken for a bare-name
 *  admin. Matched as whole-string against the cleaned text. */
const FILLER_RE =
  /^(lol+|lmao|haha+|hah|hmm+|idk|idk really|dunno|maybe|ok|okay|kk|cool|nice|sure|yeah|yep|yes|nah|nope|no|what|huh|eh|um+|erm|good|great|fine|alright|right|true|wow|omg|wtf|cheers|thanks?|ta)$/i;

/** The Turkish "just me" answers (2026-09-17), on the Turkish lower-casing. */
const JUST_ME_RE_TR =
  /^(?:sadece ben|sade ben|tek ben|yalnız ben|yalniz ben|bir tek ben|ben|benim|kimse yok|başka yok|baska yok|başkası yok|baskasi yok|başka kimse yok|baska kimse yok|ben hallederim|ben yaparım|ben yaparim|ben bakarım|ben bakarim|tek başınayım|tek basinayim|yok)(?:\s+(?:teşekkürler|tesekkurler|sağol|sagol|lütfen|lutfen|şimdilik|simdilik|abi))?$/u;

/** Turkish interjections that are not names. */
const FILLER_RE_TR =
  /^(?:tamam|tamamdır|ok|okey|bilmem|belki|hayır|hayir|yok|evet|olur|hmm+|haha+|neyse|peki|aynen|iyi|güzel|guzel)$/u;

/** Pull the digit run out of a mention/jid token. "@447700900123",
 *  "447700900123@c.us", "447700900123@lid" → "447700900123". A pure
 *  @lid id with no usable phone (e.g. "1234567890@lid" is treated as a
 *  lid, not a phone) returns null — but we KEEP the mention string so
 *  the caller can skip it gracefully. */
function digitsFromMentionToken(token: string): string | null {
  const t = token.trim();
  // "<digits>@lid" is a privacy id, NOT a phone — no usable number.
  if (/@lid$/i.test(t)) return null;
  const m = t.match(/(\d{7,})/);
  return m ? m[1] : null;
}

/** Extract a phone-like number from a free-text chunk. Accepts an
 *  optional leading "+", spaces/dashes/parens inside. Returns the cleaned
 *  "+?digits" string (NOT normalised to E.164) or null. */
function phoneFromChunk(chunk: string): string | null {
  // A run of >=7 phone characters (digits, +, space, -, parens).
  const m = chunk.match(/\+?\d[\d\s().-]{5,}\d/);
  if (!m) return null;
  const plus = /^\s*\+/.test(m[0]);
  const digits = m[0].replace(/\D/g, "");
  if (digits.length < 7) return null;
  return (plus ? "+" : "") + digits;
}

/** Strip a phone number + mention noise out of a chunk to leave the name
 *  (letters/spaces). Returns null when nothing name-like remains. */
function nameFromChunk(chunk: string): string | null {
  const cleaned = chunk
    .replace(/@\S+/g, " ")               // drop @mentions
    .replace(/\+?\d[\d\s().-]{5,}\d/g, " ") // drop phone numbers
    .replace(/[^\p{L}\s'.-]/gu, " ")     // keep letters, spaces, simple name punctuation
    .replace(/\s+/g, " ")
    .trim();
  // Need at least one alphabetic character of length >= 2.
  if (!/\p{L}{2,}/u.test(cleaned)) return null;
  return cleaned.slice(0, 80);
}

/**
 * Parse the `admins` stage answer: "who else helps run this group?".
 *
 * PURE — no normalisation to E.164 (that would lose the raw form the DB
 * layer needs); phones are returned as cleaned "+?digits" strings and
 * the conversation layer calls normalisePhone() on them.
 *
 *  - vague / "just me" / "nobody else"  → {admins:[], justMe:true}
 *  - junk / empty / unparseable          → {admins:[], justMe:false}
 *  - otherwise extract MULTIPLE admins, split on , / "and" / "&" / newlines:
 *      @mention      → {name:null, phone:<digits|null>, mention:"@<digits>"}
 *      name + phone  → {name, phone}
 *      bare phone    → {name:null, phone}
 *      bare name     → {name, phone:null}   (resolved against the org later)
 *  - dedupes entries that share a normalised phone or a lowercased name.
 *
 * `mentions` (optional, forward-compat — inbound messages don't carry it
 * today) folds extra @mention/@lid tokens in alongside the body parse.
 */
export function parseAdmins(text: string, mentions?: string[]): AdminsParse {
  const raw = (text ?? "").trim();

  // "Just me" / vague — owner already covers it. Check on a cleaned form.
  const cleaned = raw
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[!.,…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned && JUST_ME_RE.test(cleaned)) {
    return { admins: [], justMe: true };
  }
  const cleanedTr = trLower(raw)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[!.,…]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleanedTr && JUST_ME_RE_TR.test(cleanedTr)) {
    return { admins: [], justMe: true };
  }
  // Whole-string filler/interjection with no number → junk, not a name.
  if (cleaned && !/\d/.test(raw) && FILLER_RE.test(cleaned)) {
    return { admins: [], justMe: false };
  }
  if (cleanedTr && !/\d/.test(raw) && FILLER_RE_TR.test(cleanedTr)) {
    return { admins: [], justMe: false };
  }

  const admins: ParsedAdmin[] = [];
  // Dedupe keys: a Set of normalised phones and a Set of lowercased names.
  const seenPhones = new Set<string>();
  const seenNames = new Set<string>();

  const push = (a: ParsedAdmin) => {
    const phoneKey = a.phone ? normalisePhone(a.phone) ?? a.phone.replace(/\D/g, "") : null;
    const nameKey = a.name ? a.name.toLowerCase().trim() : null;
    if (phoneKey && seenPhones.has(phoneKey)) return;
    if (!phoneKey && nameKey && seenNames.has(nameKey)) return;
    if (phoneKey) seenPhones.add(phoneKey);
    if (nameKey) seenNames.add(nameKey);
    admins.push(a);
  };

  // Split the body into chunks on commas / "and" / "&" / newlines.
  const chunks = raw
    .split(/\s*(?:,|;|\n|&|\band\b|\bve\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  // First pass: parse each chunk into a partial admin (or null for junk).
  const parsed: Array<ParsedAdmin | null> = chunks.map((chunk) => {
    const mentionMatch = chunk.match(/@(\d{7,})/);
    const phone = phoneFromChunk(chunk);
    const name = nameFromChunk(chunk);
    if (mentionMatch) {
      return { name, phone: phone ?? mentionMatch[1], mention: `@${mentionMatch[1]}` };
    }
    if (name || phone) return { name, phone, mention: null };
    return null; // chunk had neither a name nor a phone — junk fragment.
  });

  // Second pass: a name-only chunk immediately followed by a bare-phone
  // chunk is one person whose name+number got split on the comma
  // ("Kemal Ediz, 07700900123"). Merge the phone up into the name entry.
  for (let i = 0; i < parsed.length - 1; i++) {
    const cur = parsed[i];
    const nxt = parsed[i + 1];
    if (cur && nxt && cur.name && !cur.phone && !cur.mention && nxt.phone && !nxt.name) {
      cur.phone = nxt.phone;
      cur.mention = cur.mention ?? nxt.mention;
      parsed[i + 1] = null;
    }
  }

  for (const a of parsed) {
    if (a) push(a);
  }

  // Fold in any forward-compat mentions[] entries (today: never present).
  for (const tok of mentions ?? []) {
    const digits = digitsFromMentionToken(tok);
    const mentionStr = digits ? `@${digits}` : tok.trim();
    if (digits) {
      push({ name: null, phone: digits, mention: mentionStr });
    } else {
      // @lid with no usable phone — record it; caller skips gracefully.
      admins.push({ name: null, phone: null, mention: mentionStr });
    }
  }

  return { admins, justMe: false };
}

// ───────────────────── when & where extraction ─────────────────────────

export const DAY_WORDS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export interface WhenWhere {
  dayOfWeek: number | null;
  kickoffTime: string | null; // "HH:MM" 24h London wall clock
  venue: string | null;       // FREE TEXT — no geocoding in Phase 1
  playersPerSide: number | null;
  recurrence: "weekly" | "oneoff" | null;
  oneOffDate: string | null;  // "YYYY-MM-DD"
}

/**
 * Turkish day names, 0 = Sunday, with and without the special letters
 * (an English keyboard types "sali" and "carsamba"). Longest first, so
 * "cumartesi" is never read as "cuma" and "pazartesi" never as "pazar".
 * A day may carry a suffix ("cumaları", "salıya", "pazartesileri"); the
 * suffix set is closed so a name like "Salih" is not a Tuesday.
 */
const DAY_RE_TR =
  /(?<!\p{L})(pazartesi|cumartesi|çarşamba|carsamba|perşembe|persembe|salı|sali|cuma|pazar)(?:lar[ıi]|ler[ıi]|lar[ıi]n[ıi]|ler[ıi]n[ıi]|ya|ye|y[ıi]|dan|den|s[ıi]|n[ıi])?(?!\p{L})/u;
const DAY_TR: Record<string, number> = {
  pazar: 0, pazartesi: 1, salı: 2, sali: 2, çarşamba: 3, carsamba: 3,
  perşembe: 4, persembe: 4, cuma: 5, cumartesi: 6,
};

/** Day-of-week from free text ("tuesdays" → 2, "cumaları" → 5). */
export function extractDayOfWeek(text: string): number | null {
  const t = text.toLowerCase();
  for (const [w, d] of Object.entries(DAY_WORDS)) {
    if (new RegExp(`\\b${w}s?\\b`).test(t)) return d;
  }
  const tr = trLower(text).match(DAY_RE_TR);
  if (tr) return DAY_TR[tr[1]] ?? null;
  return null;
}

/** Kickoff time from free text ("9pm" → "21:00", "20.30" → "20:30"). */
export function extractKickoffTime(text: string): string | null {
  const t = text.toLowerCase();
  const tm =
    t.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/) ||
    t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (!tm) return extractKickoffTimeTr(text);
  let h = parseInt(tm[1], 10);
  const min = tm[2] && /^\d{2}$/.test(tm[2]) ? tm[2] : "00";
  const mer = (tm[3] || tm[2] || "").toString();
  if (/pm/.test(mer) && h < 12) h += 12;
  if (/am/.test(mer) && h === 12) h = 0;
  if (h < 0 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${min}`;
}

/**
 * Turkish clock forms that carry no colon: "saat 9", "akşam 9'da",
 * "9 buçukta", "gece 10'da", "öğlen 1'de". A period word decides the
 * half of the day ("akşam"/"gece" add 12 to an hour under 12, "öğlen"
 * adds 12 to an hour of 6 or less); with no period word the hour is
 * taken as written. A number that belongs to a format token ("7'ye 7")
 * is never a time.
 */
function extractKickoffTimeTr(text: string): string | null {
  const t = trLower(text).replace(FORMAT_RE_TR, " ");
  const period = /(?<!\p{L})(akşam|aksam|gece|öğlen|oglen|öğle|ogle|öğleden sonra|ogleden sonra|sabah)(?!\p{L})/u.exec(t)?.[1] ?? null;
  const LOC = "(?:'?\\s*(?:n?d[ae]|n?t[ae]))";
  const m =
    // "9 buçuk", "9 buçukta", "9'da buçuk" (with or without "saat")
    new RegExp(`(?:saat\\s*)?(\\d{1,2})\\s*${LOC}?\\s*(?:buçuk|bucuk)(?:ta|te)?(?!\\p{L})`, "u").exec(t) ||
    // "saat 9", "saat 20'de"
    new RegExp(`saat\\s*(\\d{1,2})${LOC}?(?![\\d:.])`, "u").exec(t) ||
    // "akşam 9", "gece 10'da", "sabah 10"
    new RegExp(`(?:akşam|aksam|gece|öğlen|oglen|öğle|ogle|sabah)\\s*(\\d{1,2})${LOC}?(?![\\d:.])`, "u").exec(t) ||
    // a bare hour with a locative: "9'da", "20'de"
    new RegExp(`(?<![\\d:.])(\\d{1,2})\\s*'\\s*(?:n?d[ae]|n?t[ae])(?!\\p{L})`, "u").exec(t);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (Number.isNaN(h) || h > 23) return null;
  const halfPast = /(?:buçuk|bucuk)/u.test(m[0]);
  if (period && /^(akşam|aksam|gece)$/u.test(period) && h < 12) h += 12;
  if (period && /^(öğlen|oglen|öğle|ogle|öğleden sonra|ogleden sonra)$/u.test(period) && h <= 6) h += 12;
  return `${String(h).padStart(2, "0")}:${halfPast ? "30" : "00"}`;
}

/** Turkish format tokens: "7'ye 7", "6'ya 6", "5'e 5", "7v7", "7'şer",
 *  "7 kişilik". Used both to read the format and to keep those digits
 *  out of the clock reader. */
const FORMAT_RE_TR =
  /(?<!\d)(\d{1,2})\s*'?\s*(?:ye|ya|e|a)\s*(\d{1,2})(?!\d)|(?<!\d)(\d{1,2})\s*v\s*(\d{1,2})(?!\d)|(?<!\d)(\d{1,2})\s*'?\s*şer(?!\p{L})|(?<!\d)(\d{1,2})\s*kişilik/u;

/** Players-per-side ("7-a-side", "5s", "7'ye 7") — 4..16 or null. */
export function extractPlayersPerSide(text: string): number | null {
  const t = text.toLowerCase();
  const ps =
    t.match(/(\d{1,2})\s*[-\s]?\s*a[-\s]?side/) ||
    t.match(/\b(\d{1,2})\s*aside\b/) ||
    t.match(/\b(4|5|6|7|8|9|10|11)s\b/);
  if (ps) {
    const n = parseInt(ps[1], 10);
    return n >= 4 && n <= 16 ? n : null;
  }
  const tr = FORMAT_RE_TR.exec(trLower(text));
  if (!tr) return null;
  const a = tr[1] ?? tr[3] ?? tr[5] ?? tr[6];
  const b = tr[2] ?? tr[4];
  if (a == null) return null;
  if (b != null && b !== a) return null; // "7'ye 5" is not a format
  const n = parseInt(a, 10);
  return n >= 4 && n <= 16 ? n : null;
}

/**
 * Venue from free text — the "at <venue>" / "@ <venue>" tail of a
 * combined answer like "Tuesdays 9pm at Goals Wembley, 7-a-side".
 *
 * FREE TEXT ONLY in Phase 1 — stored raw, geocoding slots in later.
 * Takes the LAST "at" clause (so "at 9 at Goals" lands on "Goals"),
 * skips captures that are just a time, and strips a trailing format
 * fragment ("…, 7-a-side").
 */
export function extractVenueFreeText(raw: string): string | null {
  // Collect the start offsets of every "at "/"@ " token (a single
  // matchAll over a capture would consume "9 at Goals" in one greedy
  // match and hide the later, real venue clause).
  const re = /(?:\bat|@)\s+/gi;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) starts.push(m.index + m[0].length);
  for (let i = starts.length - 1; i >= 0; i--) {
    let v = (raw.slice(starts[i]).match(/^([^,.;\n]{2,80})/)?.[1] ?? "").trim();
    // Drop a trailing "N-a-side" fragment that slipped into the capture.
    v = v.replace(/\s*\d{1,2}\s*-?\s*a-?\s*side.*$/i, "").trim();
    // Skip pure time/number captures ("at 9pm", "at 8").
    if (/^\d{1,2}([:.]\d{2})?\s*(am|pm)?$/i.test(v)) continue;
    if (v.length >= 2) return v.slice(0, 120);
  }
  return extractVenueWithoutAt(raw);
}

/**
 * The venue when no "at" clause names it (2026-09-17): Turkish has no
 * "at", it puts a case suffix on the place ("Sim Arena'da"), and both
 * languages write the combined answer as a comma list ("Cuma 21:30, Sim
 * Arena, 7'ye 7"). Three shapes, in order:
 *
 *   1. an explicit label: "yer: Sim Arena";
 *   2. a comma-separated chunk that carries no day, time, format or
 *      recurrence token at all, so it can only be the place;
 *   3. what is left of a single chunk once the day, time, format and
 *      recurrence tokens are removed, accepted only when it looks like a
 *      place: it ends in a Turkish locative suffix ("Sim Arena'da",
 *      "halı sahada"), or it is capitalised, or it contains a venue word.
 *
 * A locative suffix is stripped from the result ("Arena'da" → "Arena",
 * "sahasında" → "sahası"), so the stored venue reads as a name.
 */
function extractVenueWithoutAt(raw: string): string | null {
  const labelled = /(?:^|[\s,;])(?:yer|yerimiz|saha|sahamız|sahamiz|venue)\s*[:=]\s*([^,.;\n]{2,80})/iu.exec(raw);
  if (labelled) return stripLocative(labelled[1].trim()).slice(0, 120);

  const chunks = raw.split(/\s*(?:,|;|\n)\s*/).map((c) => c.trim()).filter(Boolean);
  const residues = chunks.map((c) => ({ chunk: c, residue: stripScheduleTokens(c) }));

  // 2. A pure chunk: nothing schedule-like was in it.
  if (chunks.length > 1) {
    for (const { chunk, residue } of residues) {
      if (residue === chunk.replace(/\s+/g, " ").trim() && looksLikeWords(residue)) {
        return stripLocative(residue).slice(0, 120);
      }
    }
  }

  // 3. A sentence with the schedule removed.
  for (const { residue } of residues) {
    if (!looksLikeWords(residue)) continue;
    const locative = LOCATIVE_TAIL.test(residue);
    const capitalised = /^\p{Lu}/u.test(residue);
    const venueWord = VENUE_WORD.test(residue);
    if (locative || capitalised || venueWord) return stripLocative(residue).slice(0, 120);
  }
  return null;
}

const LOCATIVE_TAIL = /(?:'\s*|\s)?(?:n?d[ae]|n?t[ae])$/iu;
const VENUE_WORD =
  /(?<!\p{L})(?:saha|sahası|sahasi|arena|park|parkı|parki|goals|powerleague|league|centre|center|pitch|stadium|stadyum|astro|fc|club|kulüp|kulup|school|okul|leisure|sports|spor|tesis|tesisi|hall|salon)(?!\p{L})/iu;

/** Remove a trailing Turkish locative ("Arena'da" → "Arena", "sahada" →
 *  "saha", "sahasında" → "sahası"). Only when it is a suffix: an
 *  apostrophe or a word longer than the suffix itself. */
function stripLocative(v: string): string {
  let out = v.trim();
  // Lazy prefix so the LONGEST suffix wins: "sahasında" → "sahası", not "sahasın".
  const withApostrophe = /^(.*?\S)\s*'\s*(?:n?d[ae]|n?t[ae])$/iu.exec(out);
  const bare = withApostrophe ? null : /^(.*?\p{L}{3,}?)(?:n?d[ae]|n?t[ae])$/iu.exec(out);
  if (withApostrophe) out = withApostrophe[1].trim();
  else if (bare) out = bare[1].trim();
  // "X sahası" is "the pitch of X": the name is X. ("halı saha" is a name
  // in itself and has no possessive, so it stays.)
  out = out.replace(/\s+sahas[ıi]$/iu, "").trim();
  return out;
}

function looksLikeWords(s: string): boolean {
  return s.length >= 2 && s.length <= 80 && /\p{L}{2,}/u.test(s) && !/^\d+$/.test(s);
}

/** Strip every day, time, format and recurrence token, and the verbs a
 *  combined answer wraps them in, leaving whatever could be a place. */
function stripScheduleTokens(chunk: string): string {
  let s = chunk;
  const kill = (re: RegExp) => {
    s = s.replace(re, " ");
  };
  // format tokens (both languages)
  kill(/\d{1,2}\s*[-\s]?\s*a[-\s]?side/gi);
  kill(/\b\d{1,2}\s*aside\b/gi);
  kill(/\b(4|5|6|7|8|9|10|11)s\b/gi);
  kill(new RegExp(FORMAT_RE_TR.source, "giu"));
  // times
  kill(/\b\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?(?:\s*'?\s*(?:n?d[ae]|n?t[ae])(?!\p{L}))?/giu);
  kill(/\b\d{1,2}\s*(?:am|pm)\b/gi);
  // Turkish clock phrases with their hour: "akşam 9 buçukta", "saat 20'de"
  kill(/(?:saat\s*)?\d{1,2}\s*(?:'?\s*(?:n?d[ae]|n?t[ae]))?\s*(?:buçuk|bucuk)(?:ta|te)?(?!\p{L})/giu);
  kill(/(?<!\p{L})(?:akşam|aksam|gece|öğlen|oglen|öğle|ogle|sabah|saat)\s*\d{1,2}(?:\s*'?\s*(?:n?d[ae]|n?t[ae]))?(?![\d:.])/giu);
  kill(/(?<!\p{L})(?:saat|akşam|aksam|gece|öğlen|oglen|öğle|ogle|sabah|buçuk|bucuk|buçukta|bucukta|akşamı|aksami|günü|gunu|günleri|gunleri)(?!\p{L})/giu);
  kill(/(?<![\d:.])\d{1,2}\s*'\s*(?:n?d[ae]|n?t[ae])(?!\p{L})/giu);
  // days
  kill(/\b(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)s?\b/gi);
  kill(new RegExp(DAY_RE_TR.source, "giu"));
  // recurrence and the verbs around a schedule
  kill(/\b(?:every|each)\s+(?:week|mon|tue|wed|thu|fri|sat|sun)\w*\b/gi);
  kill(/\b(?:weekly|recurring|one[-\s]?off|just this once|this week only|we play|we kick off|kick[-\s]?off|kickoff|play|usually|normally|from|to)\b/gi);
  kill(/(?<!\p{L})(?:her|hafta|haftalık|haftalik|haftada|haftaya|tek sefer\p{L}*|bir kerelik|bir seferlik|sadece|bu|oynuyoruz|oynarız|oynariz|oynıyoruz|oynuyoruz|maç|mac|maçı|maci|maçımız|macimiz|genelde|hep|ve|ile|olarak|için|icin|başlıyoruz|basliyoruz|başlar|baslar|toplanıyoruz|toplaniyoruz)(?!\p{L})/giu);
  // leftover punctuation and whitespace
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");
  s = s.replace(/^[\s'".!?:;-]+|[\s'".!?:;-]+$/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Recurrence; the group-add flow DEFAULTS to weekly when unstated. */
export function extractRecurrence(text: string): "weekly" | "oneoff" | null {
  const t = text.toLowerCase();
  if (/\b(one[-\s]?off|just this once|one time|single (?:game|match)|this week only)\b/.test(t))
    return "oneoff";
  if (/\b(weekly|every week|each week|recurring|every (?:mon|tue|wed|thu|fri|sat|sun))/.test(t))
    return "weekly";
  const tr = trLower(text);
  if (/(?<!\p{L})(?:tek sefer\p{L}*|bir kerelik|bir seferlik|sadece bu hafta|bu haftalık|bu haftalik|tek maç|tek mac)(?!\p{L})/u.test(tr))
    return "oneoff";
  if (/(?<!\p{L})(?:her hafta|haftalık|haftalik|her (?:pazartesi|salı|sali|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar))(?!\p{L})/u.test(tr))
    return "weekly";
  return null;
}

const MONTHS_TR: Record<string, number> = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6,
  temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11,
  aralık: 12, aralik: 12,
};

/** ISO one-off date if present: "2026-09-18", "18.09.2026", "18/09/2026",
 *  "18 eylül 2026". Day-first for the numeric forms, as both languages
 *  write them here. */
export function extractOneOffDate(text: string): string | null {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/);
  if (dmy) {
    const d = parseInt(dmy[1], 10);
    const mo = parseInt(dmy[2], 10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12)
      return `${dmy[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const named = trLower(text).match(
    /(?<!\d)(\d{1,2})\s+(ocak|şubat|subat|mart|nisan|mayıs|mayis|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)\s+(20\d{2})\b/u,
  );
  if (named) {
    const d = parseInt(named[1], 10);
    const mo = MONTHS_TR[named[2]];
    if (d >= 1 && d <= 31 && mo)
      return `${named[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

/**
 * The combined "when & where do you play?" extractor — one message may
 * carry day + time + venue + format + recurrence all at once (the
 * existing multifield extraction already proved this pattern works).
 */
export function extractWhenWhere(raw: string): WhenWhere {
  return {
    dayOfWeek: extractDayOfWeek(raw),
    kickoffTime: extractKickoffTime(raw),
    venue: extractVenueFreeText(raw),
    playersPerSide: extractPlayersPerSide(raw),
    recurrence: extractRecurrence(raw),
    oneOffDate: extractOneOffDate(raw),
  };
}

// ───────────────── legacy batch extractor (moved here) ─────────────────

export interface Extracted {
  groupName: string | null;
  venue: string | null;
  dayOfWeek: number | null;
  kickoffTime: string | null;
  playersPerSide: number | null;
  recurrence: string | null;
  oneOffDate: string | null;
  featureSelection: string[] | null;
  confidence: number;
}

/** Deterministic, LLM-free extractor (moved from onboarding-conversation
 *  so it's unit-testable; behaviour unchanged). Event answers are
 *  formulaic; this keeps onboarding progressing if Anthropic is
 *  unavailable and backfills LLM misses on terse replies. Venue is
 *  intentionally not guessed here — the collecting branch's "sole
 *  missing field" heuristic handles a bare "PowerLeague Shoreditch"
 *  answer (the details stage additionally runs extractVenueFreeText). */
export function regexExtract(messages: Array<{ body: string }>): Extracted {
  const text = messages.map((m) => m.body).join("  ").toLowerCase();
  const empty: Extracted = {
    groupName: null, venue: null, dayOfWeek: null, kickoffTime: null,
    playersPerSide: null, recurrence: null, oneOffDate: null,
    featureSelection: null, confidence: 0,
  };

  const playersPerSide = extractPlayersPerSide(text);
  const dayOfWeek = extractDayOfWeek(text);
  const kickoffTime = extractKickoffTime(text);
  const recurrence = extractRecurrence(text);
  const oneOffDate = extractOneOffDate(text);

  // feature selection (only meaningful at the features stage; caller
  // decides when to use it). Numbers map to FEATURE_META order.
  let featureSelection: string[] | null = null;
  if (/\b(everything|all of (?:it|them)|all features|the lot|all)\b/.test(text)) {
    featureSelection = FEATURE_META.map((f) => f.key);
    if (/\b(except|but not|apart from|without)\b[^.]*\bpay/.test(text))
      featureSelection = featureSelection.filter((k) => k !== "paymentTracking");
  } else {
    const picked = new Set<string>();
    if (/\b(mom|man of the match|motm)\b/.test(text)) picked.add("momVoting");
    if (/\b(rating|ratings|rate)\b/.test(text)) picked.add("playerRating");
    if (/\b(attendance|in\/out|squad)\b/.test(text)) picked.add("attendance");
    if (/\bbench\b/.test(text)) picked.add("bench");
    if (/\b(teams?|balanc)/.test(text)) picked.add("teamBalancing");
    if (/\b(reminder|remind)\b/.test(text)) picked.add("reminders");
    if (/\b(stats|history|leaderboard)\b/.test(text)) picked.add("statsQa");
    if (/\bpay(ment)?s?\b/.test(text)) picked.add("paymentTracking");
    // numbered picks: "4 and 5", "options 1, 4", "1 & 4"
    const nums = text.match(/\b([1-8])\b/g);
    if (nums) for (const n of nums) {
      const meta = FEATURE_META[parseInt(n, 10) - 1];
      if (meta) picked.add(meta.key);
    }
    if (picked.size > 0) featureSelection = [...picked];
  }

  const gotAny =
    playersPerSide != null || dayOfWeek != null || kickoffTime != null ||
    recurrence != null || oneOffDate != null ||
    (featureSelection != null && featureSelection.length > 0);

  return {
    ...empty,
    playersPerSide,
    dayOfWeek,
    kickoffTime,
    recurrence,
    oneOffDate,
    featureSelection,
    confidence: gotAny ? 0.7 : 0,
  };
}

// ───────────────────── details-stage state machine ─────────────────────

export type DetailsField = "day" | "time" | "venue";

/** Which of the three UNKNOWABLE fields (only day, time, venue are
 *  mandatory — everything else has a sensible default) are still
 *  missing. Empty array ⇒ the details stage is complete. */
export function detailsStillMissing(s: {
  dayOfWeek: number | null;
  kickoffTime: string | null;
  venue: string | null;
}): DetailsField[] {
  const missing: DetailsField[] = [];
  if (s.dayOfWeek == null) missing.push("day");
  if (!s.kickoffTime) missing.push("time");
  if (!s.venue) missing.push("venue");
  return missing;
}

/** Static follow-up copy for whatever is still missing after a
 *  details-stage turn (deterministic — never depends on the LLM), in the
 *  session's language. The English bytes are pinned by copy-golden. */
export function detailsFollowUpQuestion(missing: DetailsField[], lang: Lang | string = "en"): string {
  return t(lang).onbDetailsQuestion({ missing });
}

// ───────────────────────── cancelling a setup ──────────────────────────

/**
 * "@Match Time stop" / "@Match Time iptal" during a setup ends the
 * session (2026-09-17). The tag is required, exactly as for every other
 * command, so a "stop" in ordinary chat cannot end anything; and the
 * verb must be one of a short list in either language.
 */
export function isCancelRequest(body: string): boolean {
  // The tag is tested on the plain lower-casing ("TIME" must not become
  // "tıme"); the verbs on both, since "İPTAL" only lowers correctly
  // under the Turkish rules.
  const plain = (body ?? "").toLowerCase();
  const tagged = /(?:@?\s*match\s*time|matchtime|@mt)(?!\p{L})/u.test(plain);
  if (!tagged) return false;
  const verb = /(?<!\p{L})(?:stop|cancel|quit|abort|iptal|dur|vazgeç|vazgec)(?!\p{L})/u;
  return verb.test(plain) || verb.test(trLower(body));
}

// ───────────────────────── env-flag gate ────────────────────────────────

/**
 * Safety gate for the bot-added auto-onboarding entry point. OFF unless
 * the env var is explicitly "1"/"true"/"on" — so nothing can fire on a
 * live deployment until the flag is deliberately flipped.
 */
export function isOnboardingAutostartEnabled(
  value: string | undefined = process.env.ONBOARDING_AUTOSTART,
): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}
