/**
 * THE FEE OF ONE MATCH, AS A PLAYER IS TOLD IT (club summary, slice B5;
 * decision K3, Kemal 2026-11-04). Pure: no database, no clock.
 *
 * Before B5 "the fee" meant five things (plan D9): the DM answer and the
 * group's club answer said the match's fee else the game's; the pay page
 * said "No fee set yet" without the match's own; a guest, pool or partner
 * ask said the match's fee, then the pay as you go price, then the game's
 * unless split. This is the one definition; each door reads it.
 *
 * Three named amounts go in:
 *   - `matchFee`: `Match.feePerPlayer`, what the money collector confirmed
 *     for this match (generate-upcoming-matches.ts never copies the game's
 *     fee onto a match, so a set value is always the collector's);
 *   - `paygPence`: the club's pay as you go price, given ONLY for a week of
 *     a running month (`guestPaygPence`, the summary's month facts); there
 *     the collector is asked to confirm exactly that amount
 *     (monthly-week.ts `stagePaygFee`);
 *   - `gameFee`: `Activity.feePerPlayer`, the game's usual fee, which is no
 *     per-player amount when the game splits the pitch total.
 *
 * K3: until the collector confirms the match's fee, a club that collects
 * through MatchTime tells a player the usual fee and says it is not
 * confirmed yet (`notConfirmedYet`). A club that does not collect has no
 * confirmation step, so its usual fee is stated as it is. Only a confirmed
 * fee is ever charged (`chargeableFee`): pay links, the pay page's buttons
 * and the direct pay path read the match's own fee alone.
 */

export type FeeSource =
  /** The collector confirmed this match's fee. */
  | "match"
  /** The club's pay as you go price, in a week of a running month. */
  | "payg"
  /** The game's usual fee (`Activity.feePerPlayer`). */
  | "game";

export interface FeeFact {
  /** Pounds per player, or null when no per-player amount is known. */
  amount: number | null;
  source: FeeSource | null;
  /** The collector confirmed this match's fee (`source === "match"`). */
  confirmed: boolean;
  /** The amount is the usual one and the club's collector has yet to
   *  confirm this match's fee: say "not confirmed yet" with it (K3). */
  notConfirmedYet: boolean;
  /** The game splits the pitch total between who played
   *  (`Activity.feeSplitTotal`). */
  splitTotal: boolean;
}

export interface FeeInputs {
  matchFee: number | null;
  gameFee: number | null;
  splitTotal: boolean;
  /** Only in a week of a running month; null otherwise. */
  paygPence: number | null;
  /** The club collects match fees through MatchTime (the summary's
   *  `payments.collection`): the collector confirms each
   *  match's fee in MatchTime. */
  collection: boolean;
}

export function feeFact(i: FeeInputs): FeeFact {
  const splitTotal = i.splitTotal === true;
  if (i.matchFee != null) {
    return { amount: i.matchFee, source: "match", confirmed: true, notConfirmedYet: false, splitTotal };
  }
  const usual: { amount: number; source: FeeSource } | null =
    i.paygPence != null
      ? { amount: i.paygPence / 100, source: "payg" }
      : !splitTotal && i.gameFee != null
        ? { amount: i.gameFee, source: "game" }
        : null;
  if (!usual) return { amount: null, source: null, confirmed: false, notConfirmedYet: false, splitTotal };
  return { ...usual, confirmed: false, notConfirmedYet: i.collection === true, splitTotal };
}

/** No match, so no fee to tell. */
export const NO_FEE: FeeFact = Object.freeze({ amount: null, source: null, confirmed: false, notConfirmedYet: false, splitTotal: false });

/** What may be charged: the confirmed fee, never a usual one (K3). */
export function chargeableFee(f: FeeFact): number | null {
  return f.confirmed ? f.amount : null;
}
