/**
 * AN ORGANISER CALLING THE GAME OFF WITHOUT A TAG (2026-10-29), ENGLISH.
 * The one DM asking him whether to cancel it, and the lines answering his
 * reply. A cancel done is answered with `strings.*`'s `hq_match_cancelled`
 * and `not_played_*`, the words HQ uses. House rules
 * (`__tests__/calloff-offer-copy.test.ts`): no em or en dash, no slash as a
 * separator, "bench" never "waiting list".
 */
export const calloffOfferEn = {
  /** The DM: `day` is the game's weekday ("Monday"). */
  offer: (p: { day: string }): string =>
    `Sounds like ${p.day} is off. Reply *cancel* and I'll cancel it and tell the group, or ignore this if it's still on.`,
  /** He said it is still on. */
  left_on: (p: { day: string }): string => `OK, I'll leave ${p.day} on.`,
  /** Somebody had already cancelled it. */
  already_off: (p: { game: string }): string => `${p.game} is already cancelled.`,
  /** It could not be cancelled (completed, gone, or too long ago). */
  cannot_cancel: (p: { game: string }): string => `I couldn't cancel ${p.game}. You can do it on the match page.`,
};

export type CalloffOfferStrings = { readonly [K in keyof typeof calloffOfferEn]: (typeof calloffOfferEn)[K] };
