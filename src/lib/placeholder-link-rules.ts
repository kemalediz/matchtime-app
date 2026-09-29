/**
 * WHEN A JOINER IS THE SAME PERSON AS A PLACEHOLDER (2026-09-29). Pure.
 *
 * A third-party registration ("Hamzah in") makes a phoneless placeholder
 * when the named person is not a member of the club. When that person is
 * later added to the club's WhatsApp group, group-join (or the participant
 * sweep) knows them by phone, and until now gave them a membership of
 * their own. The club then had two of them: the phone one with no games
 * and the placeholder holding the match and the team place (Sutton FC,
 * 29 Sept 2026).
 *
 * These rules decide what to do about it:
 *
 *   merge    exactly ONE linkable placeholder matches, and it matches
 *            EXACTLY (name or alias, folded for case and accents);
 *   suggest  more than one matches, or the only match is partial (a shared
 *            first name, a prefix): the admin decides, one tap on
 *            /admin/players;
 *   none     nothing matches.
 *
 * A linkable placeholder has NO phone (two phone users are two people, and
 * are never merged), belongs to THIS club only (a merge must never reach
 * into another club's roster), is still a member (an admin's Remove is a
 * decision) and was made by a provisional registration (a `provisional+`
 * email, or `provisionallyAddedAt`, which an admin's edit clears).
 *
 * The DB half is `placeholder-link.ts`.
 */
import { normaliseName } from "./name-normalise";

export interface PlaceholderCandidate {
  userId: string;
  name: string | null;
  phoneNumber: string | null;
  email: string;
  provisionallyAddedAt: Date | null;
  leftAt: Date | null;
  createdAt: Date;
  /** Memberships across ALL clubs, not just this one. */
  clubCount: number;
  /** This club's UserAlias keys for the user. */
  aliases: string[];
}

export interface JoinerIdentity {
  userId: string;
  phoneNumber: string | null;
  /** Their name, WhatsApp pushname and this club's aliases, as known. */
  names: string[];
}

export type NameMatch = "exact" | "partial";

export type LinkDecision =
  | { kind: "merge"; placeholder: PlaceholderCandidate }
  | { kind: "suggest"; candidates: PlaceholderCandidate[] }
  | { kind: "none" };

function keys(names: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    const k = normaliseName(n);
    if (k.length >= 2) out.add(k);
  }
  return [...out];
}

function firstToken(k: string): string {
  return k.split(" ")[0] ?? "";
}

/**
 * Exact when any name on one side folds to any name on the other. Partial
 * when first names agree, or one first name is a prefix of the other and
 * both are at least three letters: the same rule the resolvers use.
 */
export function matchNames(
  a: Array<string | null | undefined>,
  b: Array<string | null | undefined>,
): NameMatch | null {
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length === 0 || kb.length === 0) return null;
  if (ka.some((x) => kb.includes(x))) return "exact";
  for (const x of ka) {
    const fx = firstToken(x);
    for (const y of kb) {
      const fy = firstToken(y);
      if (fx === fy) return "partial";
      if (fx.length >= 3 && fy.length >= 3 && (fx.startsWith(fy) || fy.startsWith(fx))) return "partial";
    }
  }
  return null;
}

export function isLinkablePlaceholder(c: PlaceholderCandidate): boolean {
  if (c.phoneNumber) return false;
  if (c.leftAt) return false;
  if (c.clubCount !== 1) return false;
  return c.email.startsWith("provisional+") || c.provisionallyAddedAt !== null;
}

/** When the placeholder was added, for the admin's DM. */
export function placeholderAddedAt(c: Pick<PlaceholderCandidate, "provisionallyAddedAt" | "createdAt">): Date {
  return c.provisionallyAddedAt ?? c.createdAt;
}

export function decidePlaceholderLink(
  joiner: JoinerIdentity,
  candidates: PlaceholderCandidate[],
): LinkDecision {
  if (!joiner.phoneNumber) return { kind: "none" };
  const matches: Array<{ c: PlaceholderCandidate; m: NameMatch }> = [];
  for (const c of candidates) {
    if (c.userId === joiner.userId || !isLinkablePlaceholder(c)) continue;
    const m = matchNames(joiner.names, [c.name, ...c.aliases]);
    if (m) matches.push({ c, m });
  }
  if (matches.length === 1 && matches[0].m === "exact") {
    return { kind: "merge", placeholder: matches[0].c };
  }
  if (matches.length > 0) return { kind: "suggest", candidates: matches.map((x) => x.c) };
  return { kind: "none" };
}

/** One row of the admin roster, as far as duplicate spotting needs it. */
export interface RosterRow {
  id: string;
  name: string | null;
  phoneNumber: string | null;
  email: string;
  provisionallyAddedAt: Date | null;
  leftAt: Date | null;
  createdAt: Date;
  clubCount: number;
  aliases: string[];
}

export interface DuplicateSuggestion {
  placeholderId: string;
  placeholderName: string | null;
  keepId: string;
  keepName: string | null;
}

/**
 * The "possible duplicate" pairs shown on /admin/players: every linkable
 * placeholder against every current member WITH a phone whose name
 * matches, exactly or partially. Only a suggestion: the admin taps Merge.
 */
export function findDuplicateSuggestions(rows: RosterRow[]): DuplicateSuggestion[] {
  const keepers = rows.filter((r) => r.phoneNumber && !r.leftAt);
  const out: DuplicateSuggestion[] = [];
  for (const p of rows) {
    const cand: PlaceholderCandidate = { ...p, userId: p.id };
    if (!isLinkablePlaceholder(cand)) continue;
    for (const k of keepers) {
      if (k.id === p.id) continue;
      if (matchNames([k.name, ...k.aliases], [p.name, ...p.aliases])) {
        out.push({ placeholderId: p.id, placeholderName: p.name, keepId: k.id, keepName: k.name });
      }
    }
  }
  return out;
}
