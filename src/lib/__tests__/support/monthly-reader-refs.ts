/**
 * TEST SUPPORT: a stand-in for the MODELS that place a pasted list's lines,
 * for lists the legacy parser built (`fixtures/monthly-legacy.ts`), which
 * carry no member refs.
 *
 * Production: the monthly reader (a model) puts a member on the lines it
 * is sure of, and who-is-who (a model) is asked about every line left
 * unplaced, before the reconcile (`monthly-line-placement.ts`, review of
 * #574, round 3). No code looks a name up.
 *
 * Here a fake answers for both, as the models would on these fixtures: a
 * line whose cleaned name is exactly one member's whole name or alias, or
 * the leading name of exactly one member, is that member; a name two
 * members could be is UNCLEAR (who-is-who's "ambiguous", never "nobody");
 * anything else is nobody. Its answers then go through the REAL placement
 * (`placeListLines`), so the reconcile sees the same facts production
 * gives it, unclear lines included. Production never runs this.
 */
import { normaliseName } from "../../name-normalise";
import type { MonthlyList, MonthlyListEntry } from "../../monthly-list";
import { placeListLines, unplacedLineNames } from "../../monthly-line-placement";
import { refKey } from "../../person-ref-key";
import type { PersonPick } from "../../pipeline/who-is-who";
import { pasteShowsSameList as realPasteShowsSameList, reconcileMonthPaste as realReconcileMonthPaste } from "../../monthly-week-rules";
import {
  reconcileSignupPaste as realReconcileSignupPaste,
  signupPasteShowsSameList as realSignupPasteShowsSameList,
} from "../../month-signup-rules";

type Roster = ReadonlyArray<{ userId: string; name: string | null; aliases?: readonly string[] }>;

const key = (s: string | null | undefined) => normaliseName(s ?? "").replace(/[^\p{L}\p{N}\s'-]/gu, "").replace(/\s+/g, " ").trim();

/** The fake models' answer for one line's name. */
function fakePick(name: string, roster: Roster): PersonPick {
  const k = key(name);
  if (!k) return { kind: "none" };
  const whole = roster.filter((m) => key(m.name) === k || (m.aliases ?? []).some((a) => key(a) === k));
  const hits = whole.length > 0 ? whole : roster.filter((m) => key(m.name).startsWith(`${k} `));
  if (hits.length === 1) return { kind: "member", userId: hits[0].userId };
  if (hits.length > 1) return { kind: "ambiguous", userIds: hits.map((m) => m.userId) };
  // A line with a first name two or more members share ("Big Gary", two
  // Garys): the model is not sure which.
  const words = new Set(k.split(" "));
  const shared = roster.filter((m) => words.has(key(m.name).split(" ")[0]));
  if (shared.length > 1) return { kind: "ambiguous", userIds: shared.map((m) => m.userId) };
  return { kind: "none" };
}

/** A legacy line carries no facts: the reader's "nothing known" ones. */
function bare(e: MonthlyListEntry): MonthlyListEntry {
  return e.facts || !e.name ? e : { ...e, facts: { memberId: null, guest: false, hostUserId: null, games: null, newbie: false } };
}

/** The list as production hands it to the reconcile: every unplaced line
 *  answered by the fake who-is-who through the real placement. */
export function withReaderRefs<L extends MonthlyList>(list: L, roster: Roster): L {
  const map = (xs: MonthlyListEntry[]) => xs.map(bare);
  const facted: L = {
    ...list,
    slots: map(list.slots),
    sections: { ...list.sections, cantPlay: map(list.sections.cantPlay), reserves: map(list.sections.reserves), other: map(list.sections.other) },
  };
  const ids = new Set(roster.map((m) => m.userId));
  const picks = new Map(unplacedLineNames(facted, ids).map((n) => [refKey(n), fakePick(n, roster)]));
  return placeListLines(facted, picks, ids) as L;
}

export const reconcileMonthPaste: typeof realReconcileMonthPaste = (args) =>
  realReconcileMonthPaste({ ...args, list: withReaderRefs(args.list, args.roster) });
export const pasteShowsSameList: typeof realPasteShowsSameList = (args) =>
  realPasteShowsSameList({ ...args, list: withReaderRefs(args.list, args.roster) });
export const reconcileSignupPaste: typeof realReconcileSignupPaste = (args) =>
  realReconcileSignupPaste({ ...args, list: withReaderRefs(args.list, args.roster) });
export const signupPasteShowsSameList: typeof realSignupPasteShowsSameList = (args) =>
  realSignupPasteShowsSameList({ ...args, list: withReaderRefs(args.list, args.roster) });
