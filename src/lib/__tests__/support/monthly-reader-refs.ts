/**
 * TEST SUPPORT: the monthly READER's member refs, for lists the legacy
 * parser built (`fixtures/monthly-legacy.ts`), which carry none.
 *
 * Since 2026-11-09 (review of #574) the reconcile reads ONLY the reader's
 * `facts.memberId`; it no longer looks a line's name up in code. These
 * tests predate that and mean "Will" to be Will, so their lists go
 * through this stand-in for the reader: a line whose cleaned name is a
 * member's whole name or alias, or the leading name of exactly one member,
 * is that member; anything else is nobody (two members: nobody, as the
 * reader's "" is). Production never runs this: the reader is a model.
 */
import { normaliseName } from "../../name-normalise";
import type { MonthlyList, MonthlyListEntry } from "../../monthly-list";
import { pasteShowsSameList as realPasteShowsSameList, reconcileMonthPaste as realReconcileMonthPaste } from "../../monthly-week-rules";
import {
  reconcileSignupPaste as realReconcileSignupPaste,
  signupPasteShowsSameList as realSignupPasteShowsSameList,
} from "../../month-signup-rules";

type Roster = ReadonlyArray<{ userId: string; name: string | null; aliases?: readonly string[] }>;

const key = (s: string | null | undefined) => normaliseName(s ?? "").replace(/[^\p{L}\p{N}\s'-]/gu, "").replace(/\s+/g, " ").trim();

function standInId(name: string, roster: Roster): string | null {
  const k = key(name);
  if (!k) return null;
  const whole = roster.filter((m) => key(m.name) === k || (m.aliases ?? []).some((a) => key(a) === k));
  if (whole.length > 0) return whole.length === 1 ? whole[0].userId : null;
  const leading = roster.filter((m) => key(m.name).startsWith(`${k} `));
  return leading.length === 1 ? leading[0].userId : null;
}

function entry(e: MonthlyListEntry, roster: Roster): MonthlyListEntry {
  if (e.facts || !e.name) return e;
  return { ...e, facts: { memberId: standInId(e.name, roster), guest: false, hostUserId: null, games: null, newbie: false } };
}

/** The list with the stand-in reader's member refs on every line. */
export function withReaderRefs<L extends MonthlyList>(list: L, roster: Roster): L {
  const map = (xs: MonthlyListEntry[]) => xs.map((e) => entry(e, roster));
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

export const reconcileMonthPaste: typeof realReconcileMonthPaste = (args) =>
  realReconcileMonthPaste({ ...args, list: withReaderRefs(args.list, args.roster) });
export const pasteShowsSameList: typeof realPasteShowsSameList = (args) =>
  realPasteShowsSameList({ ...args, list: withReaderRefs(args.list, args.roster) });
export const reconcileSignupPaste: typeof realReconcileSignupPaste = (args) =>
  realReconcileSignupPaste({ ...args, list: withReaderRefs(args.list, args.roster) });
export const signupPasteShowsSameList: typeof realSignupPasteShowsSameList = (args) =>
  realSignupPasteShowsSameList({ ...args, list: withReaderRefs(args.list, args.roster) });
