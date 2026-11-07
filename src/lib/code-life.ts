/**
 * HOW LONG A CODE DM IS WORTH SENDING. Pure: no database, no clock.
 *
 * A sign-up, sign-in or claim code lives 10 minutes (phone-signup.ts,
 * claim.ts). A code DM older than that would deliver a dead code, so it is
 * failed instead of sent. The one rule, shared by the Pi's planner
 * (`planPlatformDispatch`) and the official number's handover of a code it
 * could not deliver (`codeHandoverChannel`, review of #556, S1), so the two
 * numbers can never disagree on whether a code is still alive.
 */
export const OTP_DM_TTL_MS = 10 * 60 * 1000;

/** True while a code DM created at `createdAt` is still worth sending. */
export function codeDmAlive(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= OTP_DM_TTL_MS;
}
