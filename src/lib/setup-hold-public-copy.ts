/**
 * THE PUBLIC PAGES AND THE APPROVAL HOLD (2026-10). The landing page and
 * the organiser guide describe how a club gets connected. With
 * SETUP_HOLD_ENABLED on, approval no longer makes MatchTime speak: it
 * waits for the organiser's GO. The public words must change at the
 * moment the flag is switched on, not before and not a release later.
 *
 * So the one extra sentence lives here, and each page asks
 * `setupHoldEnabledForRequest()` (setup-hold-flag.ts) server-side and
 * passes the answer in. Flag off: null, and the pages read exactly as they
 * did. English only: both pages are.
 *
 * (A statically rendered page reads the flag when it is built, so on
 * Vercel "the moment the flag is switched on" is the deploy that carries
 * the new environment value.)
 */

/** How long connecting a group takes: one wording, the DMs' ("within a day"). */
export const CONNECT_HOW_LONG = "usually within a day";

/** The "how it works" sentence that is true only under the hold. */
export function holdHowItWorksSentence(holdOn: boolean): string | null {
  return holdOn
    ? "Once your club is approved, MatchTime shows you how it has read your group and waits for you to say GO before it speaks in the group."
    : null;
}
