/**
 * IDENTITY RESOLUTION, pure, no DB.
 *
 * WHO A NAME IS, IS THE MODEL'S (2026-11-09, Kemal: "never use string
 * matching"). Code used to decide it here by spelling: an exact name, an
 * alias, a first name, a whole word, a first name a letter or two off.
 * The last of those benched the member Davide De Sousa for "David -
 * Kemal's son, is on the bench" (Vets MNF, 2026-11-09 14:42), and no
 * spelling rule can tell David from Davide while still reading "habibi"
 * as Habib. Now `who-is-who.ts` shows the model the club's members and
 * the message, and it says which member a quoted name is, that it is
 * nobody in the club, or that it could be several. `resolvePerson` only
 * reads that answer (the `PersonPicks` for the message) and checks that
 * the member it names is on the roster being resolved against. No name is
 * compared with another here.
 *
 * What stays code's, because it is about the REFERENCE and not about who
 * it matches:
 *
 *   1. A raw digit string is never a person. The 2026-05-05 Izzet/Elnur
 *      incident (`a5a150a`) had the then-analyzer read the wire's `@lid`
 *      form; the failure mode on the other side of it is provisioning a
 *      member literally called "158055467598020".
 *   2. A relationship is never a person: the extractor's `personKind`
 *      (relations, quantities, indefinites, the whole group), applied by
 *      the engine before anything is looked up.
 *   3. Ambiguity BAILS. A name the model says could be several members,
 *      or that it was not sure of, or that it gave no usable answer for,
 *      is an ambiguity: no write and a loud degradation, never a coin flip.
 */
import type { Member } from "./types";
import { refKey, type PersonPicks } from "./who-is-who";

export type ResolutionOutcome =
  | { kind: "resolved"; member: Member }
  /** The model says nobody in the club, and the ref is a usable name: a
   *  guest who could be provisioned by the caller if policy allows it. */
  | { kind: "unknown"; name: string }
  /** Several members, not sure which, or no usable answer (`why`). */
  | { kind: "ambiguous"; candidates: Member[]; why?: string }
  /** The ref cannot be a person at all: digits, or nothing usable.
   *  NEVER provisionable. */
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

function firstToken(s: string): string {
  return norm(s).split(" ")[0] ?? "";
}


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
 *
 * A HINT, NEVER A DECISION (2026-11-09): this line only tells the
 * extractor that a word is a person, so the claim is read at all. Who that
 * person is, is still the model's pick (`who-is-who.ts`); nothing here
 * resolves, moves or provisions anybody.
 */
export function membersNamedIn(
  body: string,
  roster: ReadonlyArray<Pick<Member, "name" | "aliases">>,
  max = 8,
): string[] {
  const words = norm(body ?? "").split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const text = ` ${words.join(" ")} `;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of roster) {
    const full = norm(m.name ?? "");
    if (!full || !/[a-z]/.test(full) || seen.has(m.name)) continue;
    const first = firstToken(full);
    const named = text.includes(` ${full} `) || (first.length >= 3 && words.includes(first));
    // An alias the club set ("AH" for Abdul-Hafeez, 2026-10-24), as whole
    // words: shown as the message wrote it, with the member's name.
    const alias = named ? null : aliasKeys(m).find((a) => text.includes(` ${a} `));
    if (named) out.push(m.name);
    else if (alias) out.push(`${asWritten(body, alias)} (${m.name})`);
    else continue;
    seen.add(m.name);
    if (out.length >= max) break;
  }
  return out;
}

/** A member's aliases as the resolver compares them; only those with a letter. */
function aliasKeys(m: Pick<Member, "aliases">): string[] {
  return (m.aliases ?? []).map((a) => norm(a)).filter((a) => /[a-z]/.test(a));
}

/** The words of `body` that `key` (normalised) stands for, as written. */
function asWritten(body: string, key: string): string {
  const raw = (body ?? "").split(/\s+/).filter(Boolean);
  const n = key.split(" ").length;
  for (let i = 0; i + n <= raw.length; i++) {
    const words = raw.slice(i, i + n);
    if (norm(words.join(" ")) === key) return words.join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }
  return key;
}


/**
 * WHO `ref` IS, by the model's pick for it (`picks`, from `who-is-who.ts`
 * for the message that quoted it), against `roster` (the whole club, or a
 * part of it: the players attending, the players on the teams).
 *
 *   member, on `roster`        -> resolved
 *   member, not on `roster`    -> ambiguous (a member, but not one of these)
 *   none                       -> unknown (a guest, when policy allows)
 *   ambiguous                  -> ambiguous, with its candidates on `roster`
 *   unidentified, or no pick   -> ambiguous (nobody could say who)
 *
 * A reference that cannot be a person (empty, raw digits, no letters) is
 * refused before any pick is read.
 */
export function resolvePerson(ref: string, roster: ReadonlyArray<Member>, picks: PersonPicks | undefined): ResolutionOutcome {
  const raw = (ref ?? "").trim().replace(/^@/, "").trim();
  if (!raw) return { kind: "not-a-person", why: "empty reference" };
  if (isRawDigitName(raw)) {
    return { kind: "not-a-person", why: `raw digits are never a name: "${raw}"` };
  }
  if (!/\p{L}/u.test(raw)) return { kind: "not-a-person", why: `no letters in "${raw}"` };

  const pick = picks?.get(refKey(raw));
  if (!pick) return { kind: "ambiguous", candidates: [], why: `nobody was asked who "${raw}" is` };
  switch (pick.kind) {
    case "member": {
      const member = roster.find((m) => m.userId === pick.userId);
      return member
        ? { kind: "resolved", member }
        : { kind: "ambiguous", candidates: [], why: `"${raw}" is a member who is not among these` };
    }
    case "none":
      return { kind: "unknown", name: raw };
    case "ambiguous":
      return {
        kind: "ambiguous",
        candidates: roster.filter((m) => pick.userIds.includes(m.userId)),
        why: pick.userIds.length === 1 ? `not sure "${raw}" is that member` : `"${raw}" could be several members`,
      };
    case "unidentified":
      return { kind: "ambiguous", candidates: [], why: `who "${raw}" is could not be read (${pick.why})` };
  }
}
