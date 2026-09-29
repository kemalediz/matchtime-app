/**
 * Sign-up caps (self-join plan section 7; Kemal accepted the numbers,
 * 2026-09-29). In their own module because `src/app/actions/phone-signup.ts`
 * is a "use server" file, which may export async functions only: a
 * constant exported from there breaks the build of every page importing it.
 */

/** Cap 2: sign-up codes per London day, whole site. */
export const SITE_SIGNUP_CODES_PER_DAY = 20;

/** Cap 3: sign-up attempts per requesting IP per hour. */
export const SIGNUP_ATTEMPTS_PER_IP_PER_HOUR = 5;

/** What the visitor sees when either cap is hit (plan section 7). */
export const SITE_BUSY_MESSAGE = "We're busy right now, please try again tomorrow.";
