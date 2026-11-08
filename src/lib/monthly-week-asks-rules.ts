/**
 * POOL AND PARTNER ASKS IN A MONTHLY WEEK (Vets MNF, 2026-10-29). PURE: no
 * database, no clock of its own. The adapter is `monthly-week-asks.ts`.
 *
 * A monthly club fills a free place in this order (plan 5.3): its own
 * bench, then its own pay-as-you-go players (`ensureOpenPlaceOffers`, the
 * scheduler's PAYG pool DMs), and only then the MatchTime player pool and
 * the partner clubs. A guest who comes in that way is a pay-as-you-go
 * player of that one game: never a member of the month, no credit, no
 * share of the month, and charged the club's PAYG price like any other.
 *
 *   monthlyPlacesOpen  the places an ask may fill. Once the week is seeded
 *                      it is the week list's own number (CONFIRMED against
 *                      the size), so the ask and the list say the same.
 *                      Before the seed (the hours after a game) the
 *                      regulars who will be put in, and the PAYG players
 *                      who named the date, are not open places.
 *                      An organiser who asks in words or on the page is
 *                      never held: that ask goes now (Kemal, 2026-10-29).
 *                      Nothing asks by itself (2026-11-08), so nothing here
 *                      holds an ask back any more.
 *   guestFeePounds     the fee a pool offer and a partner ask state: the
 *                      match's own fee when one is set, else the club's
 *                      PAYG price in a monthly week, else as before.
 */
import type { WeekMember, WeekRow } from "./monthly-week-rules";

export function monthlyPlacesOpen(w: { members: WeekMember[]; rows: WeekRow[]; maxPlayers: number; seeded: boolean }): number {
  const confirmed = w.rows.filter((r) => r.status === "CONFIRMED").length;
  if (w.seeded) return Math.max(0, w.maxPlayers - confirmed);
  const hasRow = new Set(w.rows.map((r) => r.userId));
  const expected = w.members.filter(
    (m) => !m.left && !hasRow.has(m.userId) && (m.kind === "regular" ? !m.absent : m.paygDated),
  ).length;
  return Math.max(0, w.maxPlayers - confirmed - expected);
}

export function guestFeePounds(f: {
  matchFee: number | null;
  activityFee: number | null;
  feeSplitTotal: boolean;
  /** The club's PAYG price, in a week of a running month only. */
  monthlyPaygPence: number | null;
}): number | null {
  if (f.matchFee != null) return f.matchFee;
  if (f.monthlyPaygPence != null) return f.monthlyPaygPence / 100;
  return f.feeSplitTotal ? null : f.activityFee;
}
