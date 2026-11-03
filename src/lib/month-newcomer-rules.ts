/**
 * AN ORGANISER ADDS SOMEBODY TO A MONTH, the pure part (Kemal, 2026-11-03).
 *
 * Vets MNF: Davide collects the money himself and, in the middle of the
 * month, re-posts the month's paid list with a new line ("14. Tom (paid)"),
 * or tags MatchTime ("@Match Time add Tom to the November list, he's paid").
 * Either way the person becomes a REGULAR of the month for the games left,
 * as "Add a player, Regular" on /admin/months does, marked as his words
 * say ("says paid", "4 only"), and goes on the next game's squad.
 *
 * WHO THE NAME IS decides what happens, on facts only:
 *   - a member MatchTime knows by name (his name or an alias here): him;
 *   - a member with NO name yet that the reader matched (by the WhatsApp
 *     name he posts under, or his number on the month's list): he COULD be
 *     the one, so nobody is added and the organiser is asked by DM;
 *   - a name that is nobody: a new player with no phone, added at once,
 *     and the organiser is asked by DM whether he is one of the members
 *     with no name yet. His answer folds the new player into that member.
 *
 * Nothing here reads a database or text. The writes are `month-newcomers.ts`.
 */
import type { MonthlyListEntry } from "./monthly-list";
import type { NamelessRef } from "./month-seed-match-rules";
import { usableName } from "./player-name-rules";

/** A new player, created from one paste or one request: at most this many.
 *  More unknown names than this is more likely a list misread than a
 *  month's worth of strangers, and the rest are not created. */
export const MAX_NEW_PLAYERS_PER_PASTE = 3;

/** How long the organiser's "who is this?" DM stays answerable. */
export const NEWCOMER_ASK_TTL_MS = 7 * 24 * 3600 * 1000;

/** The SentNotification kind of an open "who is this?" DM. */
export const NEWCOMER_ASK_KIND = "month-newcomers-ask";

/** What the organiser's line or words say about the person. */
export interface NewcomerLine {
  /** Pay as you go, not a regular. */
  payg: boolean;
  /** The days named for PAYG ("5th only" is [5]). */
  paygDays: number[];
  /** "Says paid": a claim, never a confirmation. */
  paid: boolean;
  paidPence: number | null;
  /** "4 only": the games he commits to. Null for every game. */
  games: number | null;
}

/** A club member as the rules see him. */
export interface NewcomerRosterMember {
  userId: string;
  name: string | null;
  aliases?: string[];
}

/** MatchTime knows what he is called: a usable name, or an alias here. */
export function isNamedMember(m: NewcomerRosterMember | undefined): boolean {
  if (!m) return false;
  return !!usableName(m.name) || (m.aliases ?? []).some((a) => !!usableName(a));
}

/** The line's facts, as the reader read them. */
export function newcomerLineOf(e: Pick<MonthlyListEntry, "marks" | "facts">): NewcomerLine {
  const payg = e.marks.payg;
  return {
    payg,
    paygDays: payg ? [...new Set(e.marks.paygDates.map((d) => d.day))] : [],
    paid: e.marks.paid && !payg,
    paidPence: e.marks.paid && !payg ? e.marks.paidAmountPence : null,
    games: payg ? null : (e.facts?.games ?? e.marks.gamesCommitted ?? null),
  };
}

export type NewcomerCase =
  /** Already on the month: nothing to add. */
  | { kind: "on-month"; userId: string }
  /** A member known by name: he joins now. */
  | { kind: "join"; userId: string }
  /** A member with no name yet the reader matched: he could be the one.
   *  Nobody is added; the organiser is asked. */
  | { kind: "ask"; candidateUserId: string }
  /** Nobody: a new player with no phone, added now; the organiser is asked
   *  whether he is a member with no name yet. */
  | { kind: "new" }
  /** Nothing to go on (no name, or two members it could be). */
  | { kind: "unclear" };

/**
 * PURE. What one person an organiser names for the month comes to.
 * `memberId` is the member the reader (or the name lookup) matched;
 * `brought` is a guest somebody brings for a game ("Jon extra"), who is
 * never a regular of the month.
 */
export function classifyNewcomer(p: {
  memberId: string | null;
  name: string;
  ambiguous?: boolean;
  roster: readonly NewcomerRosterMember[];
  onMonth: ReadonlySet<string>;
}): NewcomerCase {
  if (p.memberId) {
    if (p.onMonth.has(p.memberId)) return { kind: "on-month", userId: p.memberId };
    const m = p.roster.find((x) => x.userId === p.memberId);
    if (!m) return { kind: "unclear" };
    return isNamedMember(m) ? { kind: "join", userId: p.memberId } : { kind: "ask", candidateUserId: p.memberId };
  }
  if (p.ambiguous || !usableName(p.name)) return { kind: "unclear" };
  return { kind: "new" };
}

// ── The "who is this?" DM, as stored ──────────────────────────────────

/** One name the organiser is asked about. */
export interface NewcomerName {
  /** "u1", "u2" ...: what the reply reader calls it. */
  ref: string;
  /** As he wrote it ("Zak"). */
  name: string;
  /** The new player made for it (case "new"); null when nobody was added
   *  (case "ask"). */
  userId: string | null;
  line: NewcomerLine;
}

/** The open question, stored with the DM (`month-newcomers.ts`). */
export interface NewcomerQuestion {
  v: 1;
  orgId: string;
  monthId: string;
  /** The DM's exact text: his reply must be to it. */
  dm: string;
  names: NewcomerName[];
  /** The members with no name, numbered as in the DM. */
  nameless: NamelessRef[];
}

/** PURE. The stored question, checked; null when it is not one. */
export function parseNewcomerQuestion(text: string | null | undefined): NewcomerQuestion | null {
  if (!text) return null;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const q = o as Partial<NewcomerQuestion> | null;
  if (!q || q.v !== 1 || typeof q.orgId !== "string" || typeof q.monthId !== "string" || typeof q.dm !== "string") return null;
  if (!Array.isArray(q.names) || !Array.isArray(q.nameless)) return null;
  const names = q.names.filter(
    (n): n is NewcomerName => !!n && typeof n.ref === "string" && typeof n.name === "string" && (n.userId === null || typeof n.userId === "string") && !!n.line,
  );
  const nameless = q.nameless.filter((m): m is NamelessRef => !!m && typeof m.n === "number" && typeof m.userId === "string");
  return { v: 1, orgId: q.orgId, monthId: q.monthId, dm: q.dm, names, nameless };
}

/** What one "Zak is 3" does. */
export type NewcomerResolution =
  /** The new player made for the name IS this member: fold him in. */
  | { kind: "merge"; ref: string; name: string; fromUserId: string; toUserId: string }
  /** Nobody was added for the name: this member joins with the line. */
  | { kind: "link"; ref: string; name: string; userId: string; line: NewcomerLine };

/**
 * PURE. His matches ("u1 is that member"), against the open question: each
 * name once, each member once. A match naming a name already settled, or a
 * member another name was given, is dropped.
 */
export function resolveNewcomerMatches(q: NewcomerQuestion, matches: ReadonlyArray<{ listed: string; userId: string }>): NewcomerResolution[] {
  const out: NewcomerResolution[] = [];
  const usedNames = new Set<string>();
  const usedMembers = new Set<string>();
  for (const m of matches) {
    const entry = q.names.find((n) => n.ref === m.listed);
    if (!entry || usedNames.has(entry.ref) || usedMembers.has(m.userId)) continue;
    if (entry.userId === m.userId) continue;
    usedNames.add(entry.ref);
    usedMembers.add(m.userId);
    out.push(
      entry.userId
        ? { kind: "merge", ref: entry.ref, name: entry.name, fromUserId: entry.userId, toUserId: m.userId }
        : { kind: "link", ref: entry.ref, name: entry.name, userId: m.userId, line: entry.line },
    );
  }
  return out;
}
