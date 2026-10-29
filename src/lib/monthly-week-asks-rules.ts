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
 *   clubFillsFirst     the AUTOMATIC ask waits while the club's own players
 *                      have their chance: until the week is seeded, while
 *                      anyone is on its bench, and for an hour after its
 *                      PAYG players were told of the newest open place. An organiser who
 *                      asks in words or on the page is never held: that ask
 *                      goes now (Kemal, 2026-10-29, `round-rules.ts`).
 *   guestFeePounds     the fee a pool offer and a partner ask state: the
 *                      match's own fee when one is set, else the club's
 *                      PAYG price in a monthly week, else as before.
 */
import type { WeekMember, WeekRow } from "./monthly-week-rules";

const MIN_MS = 60_000;

/** The club's own PAYG players have this long, from when they were told of
 *  a place, before the automatic ask goes to the pool and partner clubs.
 *  The same hour the partners get before the pool (`POOL_AFTER_PARTNERS_MINS`). */
export const CLUB_PAYG_FIRST_MINS = 60;

/** A place the club's players were never told about (quiet hours, a lost
 *  send) holds the automatic ask at most this long from when it opened. */
export const CLUB_PAYG_UNTOLD_MAX_MINS = 120;

export function monthlyPlacesOpen(w: { members: WeekMember[]; rows: WeekRow[]; maxPlayers: number; seeded: boolean }): number {
  const confirmed = w.rows.filter((r) => r.status === "CONFIRMED").length;
  if (w.seeded) return Math.max(0, w.maxPlayers - confirmed);
  const hasRow = new Set(w.rows.map((r) => r.userId));
  const expected = w.members.filter(
    (m) => !m.left && !hasRow.has(m.userId) && (m.kind === "regular" ? !m.absent : m.paygDated),
  ).length;
  return Math.max(0, w.maxPlayers - confirmed - expected);
}

export function clubFillsFirst(i: {
  /** The match is a week of a running month. */
  monthly: boolean;
  seeded: boolean;
  pickMode: string | null | undefined;
  benchCount: number;
  /** The club's PAYG pool for this match (`loadPaygPool`). */
  paygPoolSize: number;
  /** The newest open place offer (`BenchSlotOffer`), or null. */
  newestOpenOfferAt: Date | null;
  /** The last time the club's players were told of an open place: a PAYG
   *  DM, the PAYG group line, or the week's list post. */
  clubToldAt: Date | null;
  now: Date;
}): boolean {
  if (!i.monthly) return false;
  // Not seeded yet: the week's regulars are put on it by the same poll's
  // sweep, which then offers any free place to the club's own players.
  if (!i.seeded || i.benchCount > 0) return true;
  if (i.pickMode === "organiser" || i.paygPoolSize <= 0) return false;
  if (!i.newestOpenOfferAt) return true;
  const now = i.now.getTime();
  if (!i.clubToldAt || i.clubToldAt.getTime() < i.newestOpenOfferAt.getTime()) {
    return now < i.newestOpenOfferAt.getTime() + CLUB_PAYG_UNTOLD_MAX_MINS * MIN_MS;
  }
  return now < i.clubToldAt.getTime() + CLUB_PAYG_FIRST_MINS * MIN_MS;
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
