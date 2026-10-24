/**
 * IS IT HIM? (slice L5a, review of #400 M2). PURE.
 *
 * An offer link can be forwarded ("look at this game"). Anyone may READ
 * the game's facts, but saying yes, no thanks, or giving the place back
 * changes HIS record (a place, a 14-day block, a late cancel), so those
 * need proof it is him (decision L5a.21, the least friction that is safe):
 *   - he is signed in as that player (every pool DM's stop/manage link
 *     signs him in), or
 *   - he types the LAST 4 DIGITS of the WhatsApp number the offer came to.
 *     A forwarded link's reader does not know them; five wrong tries in a
 *     day lock the digits for that offer (the signed-in way still works),
 *     so guessing 1 in 10,000 five times is the most anyone gets.
 * Once proved, a cookie for that one offer (`offer-token.ts`
 * `poolOfferProof`) keeps him proved on this phone. Unproved, the page
 * shows the game's facts only: never his distance (it says where he lives).
 */
export const POOL_OFFER_PROOF = Object.freeze({
  digits: 4,
  wrongPerOfferPerDay: 5,
  cookieDays: 30,
});

export const proofCookieName = (offerId: string): string => `mt-pool-offer-${offerId}`;

/** Exactly four digits, equal to the last four of his number. */
export function digitsMatch(phone: string | null | undefined, digits: unknown): boolean {
  if (typeof digits !== "string" || !new RegExp(`^\\d{${POOL_OFFER_PROOF.digits}}$`).test(digits.trim())) return false;
  const own = (phone ?? "").replace(/\D/g, "");
  return own.length >= POOL_OFFER_PROOF.digits && own.slice(-POOL_OFFER_PROOF.digits) === digits.trim();
}

export type DigitsAnswer = "ok" | "wrong" | "locked";

export function digitsAnswer(a: { match: boolean; wrongToday: number }): DigitsAnswer {
  if (a.wrongToday >= POOL_OFFER_PROOF.wrongPerOfferPerDay) return "locked";
  return a.match ? "ok" : "wrong";
}
