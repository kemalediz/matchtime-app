/**
 * WHO EACH UNPLACED LINE OF A PASTED MONTHLY LIST IS, decided BEFORE the
 * reconcile (review of #574, round 3).
 *
 * The monthly reader puts a member on each line it is sure of. Its "" on a
 * line means nobody, or somebody it was not sure of, and the reconcile
 * used to read both as nobody: an organiser's misspelt bencher then read
 * as "left off the bench" and was taken off, a member's misspelt line
 * became a guest past every rule a member's line is held to, and guests
 * that were members used up the guest cap. So every unplaced line goes to
 * who-is-who first (`monthly-paste.ts`, one call per paste, the whole club
 * shown), and its answer is written on the line here:
 *
 *   - a member it is sure of: the line's member. The reconcile's rules for
 *     a member's line then apply (stale re-adds, not on the month, the
 *     bench), and it is never a guest.
 *   - nobody: the line stays nobody's (a guest or an organiser's new
 *     player, by the reconcile's rules).
 *   - anything else: UNCLEAR, with the members it could be (none listed:
 *     anybody). Never a new person, and never read as leaving somebody off.
 *
 * Pure: no database, no model.
 */
import type { MonthlyLineFacts, MonthlyList, MonthlyListEntry } from "./monthly-list";
import { refKey } from "./person-ref-key";
import type { PersonPick } from "./pipeline/who-is-who";

const NO_FACTS: MonthlyLineFacts = { memberId: null, guest: false, hostUserId: null, games: null, newbie: false };

const isUnplaced = (e: MonthlyListEntry, rosterIds: ReadonlySet<string>): boolean =>
  !!e.name && !(e.facts?.memberId && rosterIds.has(e.facts.memberId));

function entriesOf(list: MonthlyList): MonthlyListEntry[] {
  return [...list.slots, ...list.sections.cantPlay, ...list.sections.reserves, ...list.sections.other];
}

/** The names of the lines no member of the club is on, each once, in the
 *  list's order: what who-is-who is asked. */
export function unplacedLineNames(list: MonthlyList, rosterIds: ReadonlySet<string>): string[] {
  return [...new Set(entriesOf(list).filter((e) => isUnplaced(e, rosterIds)).map((e) => e.name))];
}

/** The list with who-is-who's answers (keyed by `refKey` of the line's
 *  name) written on its unplaced lines. */
export function placeListLines(
  list: MonthlyList,
  picks: ReadonlyMap<string, PersonPick>,
  rosterIds: ReadonlySet<string>,
): MonthlyList {
  const place = (e: MonthlyListEntry): MonthlyListEntry => {
    if (!isUnplaced(e, rosterIds)) return e;
    const facts = { ...(e.facts ?? NO_FACTS), memberId: null };
    const pick = picks.get(refKey(e.name));
    if (pick?.kind === "member" && rosterIds.has(pick.userId)) {
      return { ...e, facts: { ...facts, memberId: pick.userId, guest: false } };
    }
    if (pick?.kind === "none") return { ...e, facts };
    const candidates = pick?.kind === "ambiguous" ? pick.userIds.filter((id) => rosterIds.has(id)) : [];
    return { ...e, facts: { ...facts, unclear: { candidates } } };
  };
  const map = (xs: MonthlyListEntry[]) => xs.map(place);
  return {
    ...list,
    slots: map(list.slots),
    sections: {
      ...list.sections,
      cantPlay: map(list.sections.cantPlay),
      reserves: map(list.sections.reserves),
      other: map(list.sections.other),
    },
  };
}
