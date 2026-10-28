/**
 * THE CLUB FEE PRICE, IN WORDS. CLIENT-SAFE and pure.
 *
 * The price is `STANDARD_PRICE_PENCE` in club-billing-rules.ts (GBP 4.99
 * since 2026-10-28). Every page and message that states it, or a number
 * worked out from it (3 weeks out of 4, the most a game costs, a player's
 * share), reads it here, so the copy cannot say one price while the
 * billing charges another. `no-stale-price-copy.test.ts` fails on a typed
 * old price.
 */
import { CUSTOM_PRICE_MAX_PENCE, CUSTOM_PRICE_MIN_PENCE, GAMES_PER_WEEKLY_SLOT, STANDARD_PRICE_PENCE } from "./club-billing-rules";

/** "£4.99", "£5", "£8.25": as `gbp()` in payments.ts writes match fees. */
export function moneyLabel(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

/** Always with pence: "£1.00". */
function poundsAndPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Pence under GBP 1 as "13p", else as money. */
function penceLabel(pence: number): string {
  return pence < 100 ? `${pence}p` : moneyLabel(pence);
}

/** "£4.99". */
export const STANDARD_PRICE_LABEL = moneyLabel(STANDARD_PRICE_PENCE);

/** "between £1.00 and £4.99": what the platform owner may type for Custom. */
export const CUSTOM_PRICE_RANGE_LABEL = `between ${poundsAndPence(CUSTOM_PRICE_MIN_PENCE)} and ${poundsAndPence(CUSTOM_PRICE_MAX_PENCE)}`;

/** A Standard month with `played` of `scheduled` games played: the fee,
 *  floored to the penny as `monthFee` charges it ("£3.74" for 3 of 4). */
export function standardWeeksPlayedLabel(played: number, scheduled: number): string {
  return moneyLabel(Math.floor((STANDARD_PRICE_PENCE * played) / scheduled));
}

/** The most one game played costs the club on Standard, one weekly game:
 *  the price over four weeks, rounded UP to the penny ("£1.25"), as
 *  `clubFeeTip` works out `perGamePence`. */
export const STANDARD_PER_GAME_MAX_PENCE = Math.ceil(STANDARD_PRICE_PENCE / GAMES_PER_WEEKLY_SLOT);
export const STANDARD_PER_GAME_MAX_LABEL = moneyLabel(STANDARD_PER_GAME_MAX_PENCE);

/** That game's cost per player, rounded UP to the penny ("13p" for 10). */
export function standardPerPlayerPerGameLabel(players: number): string {
  return penceLabel(Math.ceil(STANDARD_PER_GAME_MAX_PENCE / players));
}

/** A Standard month charged in full, shared by `players`, to the nearest
 *  penny ("25p" for 20): the pricing page's "about". */
export function standardMonthSharedLabel(players: number): string {
  return penceLabel(Math.round(STANDARD_PRICE_PENCE / players));
}
