/**
 * A REFUSED POOL ASK, ASKED AGAIN ON ITS OWN (2026-10-28), ENGLISH. One
 * line on top of the ask's own reply (`poolHqAskReply`), saying why it
 * happens now: the organiser fixed what was missing and nobody had to say
 * "done". House rules (`__tests__/pool-ask-retry-copy.test.ts`): no em or
 * en dash, no slash as a separator, "bench" never "waiting list".
 */
export const poolAskRetryEn = {
  /** The venue was set and the pool was asked. */
  venue_set_asked: "Your pitch is set, so I've asked the player pool now:",
  /** The venue was set, the pool was asked again, and it said no again (the reason follows). */
  venue_set_refused: "Your pitch is set, so I tried the player pool again:",
};

export type PoolAskRetryStrings = { readonly [K in keyof typeof poolAskRetryEn]: string };
