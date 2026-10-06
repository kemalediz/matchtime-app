/**
 * WHICH OPEN BENCH OFFERS HAS SOMEBODY NOT BEEN TOLD ABOUT YET?
 *
 * Several places can open at once: an organiser-pick club's fallback
 * ("nobody picked in time, offer it to the waiting list") opens one
 * `BenchSlotOffer` per place, and so does a monthly club's open-place
 * sweep. Each offer is one claimable place, which is right: two waiting
 * players can each take one. What was wrong was announcing each offer
 * separately, so three open places meant three identical group posts and
 * three DMs per waiting player (2026-10-06).
 *
 * The scheduler now announces every offer the audience has not been told
 * about in ONE message, keyed on the NEWEST of them. No schema change and
 * no new key shape: the key is still `offer-<id>` (and
 * `offer-<id>:dm:<userId>`), so the ack still stamps the WhatsApp message
 * id onto an offer and a single drop is keyed exactly as it always was.
 *
 * "Told" is read back from those keys: an announcement keyed on offer X
 * covered X and every offer of the match opened at or before X. So an
 * offer is untold when it is newer than the newest offer an announcement
 * was keyed on. Compared by the offers' own `createdAt`, never by when
 * the message went out, so an offer opened while a post is on its way is
 * not mistaken for one the post covered.
 *
 * The newest offer carries the key because claims take the oldest first
 * (`resolveBenchConfirmation`): it is the last to go, so a 👍 on the post
 * finds an open offer for as long as there is a place to take.
 *
 * Pure: no database, no clock.
 */

export interface OfferStamp {
  id: string;
  createdAt: Date;
}

/** Oldest first; the id breaks a tie so the order is stable. */
function byAge(a: OfferStamp, b: OfferStamp): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The open offers this audience has not been told about, oldest first.
 *
 * `open`      the match's open offers.
 * `closed`    the match's other offers (taken, refilled, swept). An
 *             announcement may have been keyed on one of them; pass []
 *             when they have not been read.
 * `announced` was an announcement keyed on this offer sent to the
 *             audience (the group, or one waiting player)?
 */
export function untoldOffers<T extends OfferStamp>(
  open: readonly T[],
  closed: readonly OfferStamp[],
  announced: (offerId: string) => boolean,
): T[] {
  let toldUpTo = -Infinity;
  for (const o of [...open, ...closed]) {
    if (announced(o.id)) toldUpTo = Math.max(toldUpTo, o.createdAt.getTime());
  }
  return open.filter((o) => o.createdAt.getTime() > toldUpTo).sort(byAge);
}

/** The offer an announcement of `untold` is keyed on: the newest. */
export function leadOffer<T extends OfferStamp>(untold: readonly T[]): T | null {
  return untold.length > 0 ? [...untold].sort(byAge)[untold.length - 1] : null;
}
