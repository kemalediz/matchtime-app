/**
 * MATCHING A LIST'S UNKNOWN NAMES TO NAMELESS MEMBERS (2026-11-03), the
 * pure part. Vets MNF: most members were imported from the WhatsApp member
 * list with no name, so "Nabz (paid 4 only)" on the organiser's list
 * matched nobody, and only 4 of 13 went on the month. The draft now keeps
 * each name it could not match, with what its line says, and the organiser
 * says who it is: on the months page (`month-seed-match.ts`) or in his own
 * words in reply to the DM (`month-seed-reply.ts`, read by the model).
 *
 * No database here, and nothing reads text.
 */
import type { MemberKind, MemberTier, SeedDraftUnmatched, SeedPaid, SeedRowInput } from "./squad-month-rules";

/** A name on the list that matched nobody, with its line's facts. */
export interface SeedUnmatchedEntry {
  /** "u1", "u2" ...: stable for the life of the draft. */
  ref: string;
  /** As the list writes it ("steff"). */
  name: string;
  slot: number | null;
  kind: MemberKind;
  tier: MemberTier;
  paid: SeedPaid;
  paidAmountPence: number | null;
  gamesCommitted: number | null;
  /** Named members it could be (an ambiguous name). Empty when unknown. */
  candidates: string[];
}

/** A nameless member as numbered in the DM the organiser was sent. */
export interface NamelessRef {
  /** The number he sees ("3. +44 7700 900123"). */
  n: number;
  userId: string;
}

/** The draft's unknown names, each with its ref. */
export function unmatchedEntries(unmatched: readonly SeedDraftUnmatched[]): SeedUnmatchedEntry[] {
  return unmatched.map((u, i) => ({
    ref: `u${i + 1}`,
    name: u.name,
    slot: u.slot,
    kind: u.kind,
    tier: u.tier,
    paid: u.paid,
    paidAmountPence: u.paidAmountPence,
    gamesCommitted: u.gamesCommitted,
    candidates: [...u.candidates],
  }));
}

export type ListMatchError = "no-such-name" | "already-on";

/**
 * The draft with one unknown name matched to a member: the name leaves the
 * unknown list and the member joins the draft with that line's facts (paid,
 * "4 only", PAYG) and the list's own wording. A member already on the draft
 * is refused (two lines would be one person). The line's number is kept
 * unless another row already has it.
 */
export function applyListMatch<D extends { rows: SeedRowInput[]; unmatched?: SeedUnmatchedEntry[] }>(
  data: D,
  ref: string,
  userId: string,
): { ok: true; data: D; entry: SeedUnmatchedEntry } | { ok: false; error: ListMatchError } {
  const entry = (data.unmatched ?? []).find((u) => u.ref === ref);
  if (!entry) return { ok: false, error: "no-such-name" };
  if (data.rows.some((r) => r.userId === userId)) return { ok: false, error: "already-on" };
  const taken = new Set(data.rows.map((r) => r.slot).filter((s): s is number => typeof s === "number"));
  const row: SeedRowInput = {
    userId,
    kind: entry.kind,
    tier: entry.tier,
    slot: entry.slot !== null && !taken.has(entry.slot) ? entry.slot : null,
    paid: entry.paid,
    paidAmountPence: entry.paidAmountPence,
    gamesCommitted: entry.gamesCommitted,
    listName: entry.name,
  };
  return {
    ok: true,
    entry,
    data: { ...data, rows: [...data.rows, row], unmatched: (data.unmatched ?? []).filter((u) => u.ref !== ref) },
  };
}

/** The nameless members numbered 1, 2, 3 ... in the order given. */
export function numberNameless(userIds: readonly string[]): NamelessRef[] {
  return userIds.map((userId, i) => ({ n: i + 1, userId }));
}

/**
 * What a list was READ as, as one string: the matched lines (who, how they
 * pay, "4 only", the number) and the names it could not match. Two
 * readings of the same list are the same key, so a list read twice (two
 * messages of one flush both read as it, a re-post of the same list) is
 * offered to the organiser once, and his corrections to the first offer
 * are not thrown away (2026-11-03, the Vets sandbox's double DM).
 */
export function seedReadKey(rows: readonly SeedRowInput[], unmatched: readonly Pick<SeedUnmatchedEntry, "name">[] = []): string {
  const line = (r: SeedRowInput) =>
    [r.userId, r.kind, r.tier ?? "standard", r.slot ?? "", r.paid ?? "none", r.paidAmountPence ?? "", r.gamesCommitted ?? "", (r.listName ?? "").trim().toLowerCase()].join("|");
  return JSON.stringify({
    rows: rows.map(line).sort(),
    unmatched: unmatched.map((u) => u.name.trim().toLowerCase()).sort(),
  });
}
