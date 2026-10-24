/**
 * IDENTITY RESOLUTION — pure, no DB.
 *
 * §9 classifies the identity guards as SURVIVORS: "Ambiguity bails are
 * load-bearing and orthogonal" to who decides. They are not scar tissue
 * and they are not going away; what changes is that they run on a
 * `personRef` the model quoted verbatim rather than on a name it may
 * have invented, and they run BEFORE anything can write.
 *
 * Three rules, in order of how much damage they prevent:
 *
 *   1. A raw digit string is never a person. The 2026-05-05 Izzet/Elnur
 *      incident (`a5a150a`) had the then-analyzer read the wire's `@lid`
 *      form; the failure mode on the other side of it is provisioning a
 *      member literally called "158055467598020".
 *   2. A relationship is never a person. `isPlaceholderGuestName` from
 *      `guest-name-ask.ts` is reused rather than reimplemented — §4.1
 *      measured the then-incumbent analyzer provisioning "Amir's
 *      brother" into a paid squad six times out of six.
 *
 *   (Both are cited in the past tense on purpose. §10 step 8 deleted
 *   `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT`, so neither
 *   decider exists to be corrected any more. These three rules are not a
 *   second opinion on somebody else's output — they are the only thing
 *   standing between a quoted `personRef` and a row in the database.)
 *   3. Ambiguity BAILS. Two members whose names both match gets no
 *      write and a loud degradation, never a coin flip.
 */
import { isPlaceholderGuestName } from "../guest-name-ask";
import type { Member } from "./types";

export type ResolutionOutcome =
  | { kind: "resolved"; member: Member }
  /** No member matches, and the ref is a usable name — a guest who could
   *  legitimately be provisioned by the caller if policy allows it. */
  | { kind: "unknown"; name: string }
  | { kind: "ambiguous"; candidates: Member[] }
  /** The ref cannot be a person at all: digits, a relationship word, or
   *  nothing usable. NEVER provisionable. */
  | { kind: "not-a-person"; why: string };

/** A pushname that is really just digits ("447700900009", "1580554675…").
 *  Mirrors `isRawDigitName` in the analyze route. */
export function isRawDigitName(raw: string): boolean {
  const t = (raw ?? "").trim();
  if (!t) return false;
  return /^[+@]?[\d\s()+-]{5,}$/.test(t);
}

/**
 * Letters NFD cannot decompose, so `.normalize("NFD")` leaves them and
 * the a-z filter below would DELETE them: "Ayd\u0131n" would become "aydn"
 * and stop matching "Aydin Celik". This squad is Turkish, Azerbaijani
 * and South Asian; the dotless \u0131 is a first name away from a missed
 * registration.
 */
const TRANSLITERATE: Record<string, string> = {
  "\u0131": "i", // \u0131  dotless i
  "\u0130": "i", // \u0130  dotted capital I
  "\u0142": "l", // \u0142
  "\u0111": "d", // \u0111
  "\u00f0": "d", // \u00f0
  "\u00fe": "th", // \u00fe
  "\u00df": "ss", // \u00df
  "\u00e6": "ae", // \u00e6
  "\u00f8": "o", // \u00f8
};

// Digits are KEPT (2026-10-22): "C1" and "C2" used to both normalise to
// "c", so "C1, C2 OUT" dropped C1 twice and left C2 in (MT Test). A
// reference still needs a letter to be a person (`resolvePerson`).
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/./gu, (ch) => TRANSLITERATE[ch] ?? ch)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `norm` without spaces, for a reference carrying a digit only: "Ali2"
 *  is "Ali 2". Digit-free names never use it, so they match as before. */
function compact(s: string): string {
  return norm(s).replace(/\s+/g, "");
}

function firstToken(s: string): string {
  return norm(s).split(" ")[0] ?? "";
}

/**
 * A near miss that is safe to accept.
 *
 * ⚠️ TIGHTENED after an adversarial review found the first version
 * resolving the WRONG PERSON on ordinary names from this squad's own
 * distribution: "Sami" resolved to Samir Khan and "Hasan" to Hasanali
 * Zaidi. A tagged "Sami is out" about a guest would then have dropped a
 * confirmed member, and the engine's personNamed override (which trusts
 * this function over the model) amplifies it.
 *
 * So a near miss now needs BOTH: at least five characters on the shorter
 * side, and a length difference of at most two. That still covers
 * "habibi" → "Habib" (the real S12 message, difference 1) and "Aydin" →
 * "Aydın" once accents are stripped, and refuses everything above.
 */
const NEAR_MISS_MIN_LENGTH = 5;
const NEAR_MISS_MAX_EXTRA = 2;

function nearMiss(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length);
  if (shorter < NEAR_MISS_MIN_LENGTH) return false;
  if (Math.abs(a.length - b.length) > NEAR_MISS_MAX_EXTRA) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Words that address the GROUP rather than a person. "@everyone in" is
 * entirely idiomatic in a football group and the deterministic floor
 * routes it as a third-party add, so without this the engine provisions
 * a member called "everyone" and confirms them into the squad.
 *
 * Kept here rather than added to `guest-name-ask.ts`'s list: that module
 * is shipped and its list drives `stripPlaceholderGuests` on the live
 * path. This is the pipeline's own additional refusal.
 */
const GROUP_ADDRESS =
  /^(?:@?everyone|@?everybody|@?all(?:\s+of\s+(?:you|us))?|the\s+group|the\s+lads|the\s+boys|lads|boys|guys|team|squad)$/i;

/**
 * THE CLUB'S MEMBERS A MESSAGE NAMES, from the club's records (2026-10-24).
 *
 * FNF HQ, 2026-10-24 11:43 UTC: "Glazers OUT", about Glazers, a member an
 * organiser had put on the bench minutes before, came back from the
 * attendance extractor with no claim at all (measured on the dev key, the
 * same input production sends: 2 of 2 empty, while "Tom OUT" and
 * "Shehryar OUT" each gave an "out" claim). The extractor is never shown
 * the squad, so a name that is also an ordinary word or a well-known
 * phrase is not known to be a person, and the message went silent.
 *
 * This is identity lookup, the resolver's own job, never a reading of what
 * the message means: which roster names appear in the words, so the
 * extractor is TOLD those words are people in this club. What the message
 * says about them is still the model's to read. A member is listed when
 * their full name appears as whole words, or their first name (three
 * letters or more) does. Full names, each once, at most `max`.
 */
export function membersNamedIn(body: string, roster: ReadonlyArray<Pick<Member, "name">>, max = 8): string[] {
  const words = norm(body ?? "").split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const text = ` ${words.join(" ")} `;
  const out: string[] = [];
  for (const m of roster) {
    const full = norm(m.name ?? "");
    if (!full || !/[a-z]/.test(full)) continue;
    const first = firstToken(full);
    const named = text.includes(` ${full} `) || (first.length >= 3 && words.includes(first));
    if (named && !out.includes(m.name)) out.push(m.name);
    if (out.length >= max) break;
  }
  return out;
}

export function resolvePerson(ref: string, roster: Member[]): ResolutionOutcome {
  const raw = (ref ?? "").trim().replace(/^@/, "").trim();
  if (!raw) return { kind: "not-a-person", why: "empty reference" };
  if (isRawDigitName(raw)) {
    return { kind: "not-a-person", why: `raw digits are never a name: "${raw}"` };
  }
  if (isPlaceholderGuestName(raw)) {
    return { kind: "not-a-person", why: `a relationship is not a name: "${raw}"` };
  }
  if (GROUP_ADDRESS.test(raw.replace(/\s+/g, " ").trim())) {
    return { kind: "not-a-person", why: `"${raw}" addresses the group, not a person` };
  }

  const target = norm(raw);
  if (!/[a-z]/.test(target)) return { kind: "not-a-person", why: `no letters in "${raw}"` };

  // 1. Exact full-name match ("Ali2" is "Ali 2" when there is a digit).
  const hasDigit = /[0-9]/.test(target);
  const exact = roster.filter((m) => norm(m.name) === target || (hasDigit && compact(m.name) === compact(target)));
  if (exact.length === 1) return { kind: "resolved", member: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  // 2. First-name match. `target` may itself be several words
  //    ("my dad Najib") so we compare on the first token of each.
  const tFirst = firstToken(target);
  const byFirst = roster.filter((m) => firstToken(m.name) === tFirst);
  if (byFirst.length === 1) return { kind: "resolved", member: byFirst[0] };
  if (byFirst.length > 1) return { kind: "ambiguous", candidates: byFirst };

  // 3. The ref names someone whose full name CONTAINS the ref as a whole
  //    token ("Ul Haq" → "Ehtisham Ul Haq").
  const byToken = roster.filter((m) => norm(m.name).split(" ").includes(tFirst));
  if (byToken.length === 1) return { kind: "resolved", member: byToken[0] };
  if (byToken.length > 1) return { kind: "ambiguous", candidates: byToken };

  // 4. Near miss on the first name.
  const near = roster.filter((m) => nearMiss(firstToken(m.name), tFirst));
  if (near.length === 1) return { kind: "resolved", member: near[0] };
  if (near.length > 1) return { kind: "ambiguous", candidates: near };

  // 5. ANY token of the reference against the roster's first names.
  //
  // §6.2's own worked example is `{other, "my dad Najib", named=true}`,
  // and "my dad Najib" has first token "my", so steps 1-4 all miss even
  // when Najib is on the roster — and `isPlaceholderGuestName` correctly
  // says it is NOT a placeholder, because a real name is attached. The
  // result was a duplicate member called "my dad Najib" beside the real
  // Najib. Two different members matching different tokens is an
  // ambiguity and bails, as everywhere else here.
  const tokens = target.split(" ").filter((t) => t.length >= 3);
  const byAnyToken = roster.filter((m) => tokens.includes(firstToken(m.name)));
  if (byAnyToken.length === 1) return { kind: "resolved", member: byAnyToken[0] };
  if (byAnyToken.length > 1) return { kind: "ambiguous", candidates: byAnyToken };

  return { kind: "unknown", name: raw };
}
