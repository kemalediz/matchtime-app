/**
 * SIGN-UP, SIGN-IN AND CLAIM CODES ON WHATSAPP: THE ONE DOOR (WhatsApp
 * Cloud API plan, PR C7a). Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md,
 * sections 3.1, 5.1, 5.5 and section 6 items 4 and 5.
 *
 * Every code DM (the sign-up and sign-in codes of phone-signup.ts, the
 * claim code of claim.ts) is queued here, and only here
 * (`send-channel-source-guard.test.ts`). This is a thin layer over
 * `queuePlatformDm`, purpose "otp": that function still decides the
 * channel, once, with `channelFor`, and nothing here picks one.
 *
 *   - It names Meta's authentication template `mt_code` (decision 4) with
 *     the code and the person's language. `queuePlatformDm` fills it with
 *     C6's `templateParams` and stores it only on a job for the official
 *     number; a club number job stores none of it.
 *   - `text` is kept on every job as today: it is what the club number
 *     sends, today and when the official number cannot send a live code
 *     and hands it over (decision 5, the Cloud dispatcher).
 *   - It answers which number to name on the page (`codeSenderNumber`):
 *     the official number when the code goes from it, otherwise nothing,
 *     so with the flags off the pages are exactly what they were.
 *
 * The code still lives 10 minutes (phone-signup.ts, claim.ts); the Cloud
 * dispatcher drops a code older than that (OTP_DM_TTL_MS), as the Pi does.
 */
import { headers } from "next/headers";
import { codeSenderNumber } from "./club-connect";
import { langFromAcceptLanguage } from "./club-connect-rules";
import { DEFAULT_LANG, type Lang } from "./i18n/lang";
import { queuePlatformDm } from "./platform-jobs";

/** The person's language for the code's template: the browser's first
 *  preference, as `useBrowserLang` reads it on the page. English outside
 *  a request. */
export async function codeLangFromRequest(): Promise<Lang> {
  try {
    return langFromAcceptLanguage((await headers()).get("accept-language"));
  } catch {
    return DEFAULT_LANG;
  }
}

/** Queue a code DM. `from`: the number the page may name, or null. */
export async function queueCodeDm(args: { phone: string; code: string; text: string; lang: Lang }): Promise<{ from: string | null }> {
  const { channel } = await queuePlatformDm({
    phone: args.phone,
    purpose: "otp",
    text: args.text,
    template: { name: "mt_code", lang: args.lang, facts: { code: args.code } },
  });
  return { from: codeSenderNumber(channel) };
}
