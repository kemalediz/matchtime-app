/**
 * SIGN-UP, SIGN-IN AND CLAIM CODES ON WHATSAPP: THE ONE DOOR (WhatsApp
 * Cloud API plan, PR C7a). Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md,
 * sections 3.1, 5.1, 5.5 and section 6 items 4 and 5.
 *
 * Every code (the sign-up and sign-in codes of phone-signup.ts, the claim
 * code of claim.ts) is issued by `issueCode` here, and only here
 * (`send-channel-source-guard.test.ts`), so every code is held to the same
 * caps (review of #556, S2: the claim code had only the per phone one):
 *   - 3 codes an hour per phone;
 *   - SIGNUP_ATTEMPTS_PER_IP_PER_HOUR per requesting IP (first
 *     x-forwarded-for hop, else x-real-ip; no header, no IP cap), the IP
 *     stored on the code;
 *   - SITE_SIGNUP_CODES_PER_DAY a London day, whole site.
 * It reads PhoneOtp only, never User: no answer it gives can depend on
 * whether the number has an account.
 *
 * The DM is a thin layer over `queuePlatformDm`, purpose "otp": that
 * function still decides the channel, once, with `channelFor`, and nothing
 * here picks one.
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
import { randomInt } from "node:crypto";
import { headers } from "next/headers";
import { codeSenderNumber } from "./club-connect";
import { langFromAcceptLanguage } from "./club-connect-rules";
import { db } from "./db";
import { DEFAULT_LANG, type Lang } from "./i18n/lang";
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { queuePlatformDm } from "./platform-jobs";
import { SIGNUP_ATTEMPTS_PER_IP_PER_HOUR, SITE_BUSY_MESSAGE, SITE_SIGNUP_CODES_PER_DAY } from "./signup-caps";

/** A code lives this long; the DM is not sent after it (code-life.ts). */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Codes per phone per hour. */
const MAX_OUTSTANDING_PER_HOUR = 3;

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

/** The requesting client's IP: the first x-forwarded-for hop, else x-real-ip. */
async function requestIp(): Promise<string | null> {
  try {
    const h = await headers();
    const first = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim();
    const ip = first || (h.get("x-real-ip") ?? "").trim();
    return ip ? ip.slice(0, 64) : null;
  } catch {
    // Outside a request (a script, a test harness): nothing to attribute.
    return null;
  }
}

/** A code was sent. `from`: the number it comes from, only when the page
 *  should name it (the official number, PR C7a); absent otherwise. */
export type CodeSent = { ok: true; from?: string };
export type CodeRefused = { ok: false; error: string };

/**
 * Issue a code for `digits` (E.164 without "+") and DM it. Every cap lives
 * here, so every code action is held to the same ones. `text` builds the
 * club number's message around the code.
 */
export async function issueCode(digits: string, text: (code: string) => string): Promise<CodeSent | CodeRefused> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db.phoneOtp.count({ where: { phone: digits, createdAt: { gte: hourAgo } } });
  if (recent >= MAX_OUTSTANDING_PER_HOUR) {
    return { ok: false, error: "Too many requests. Please wait a bit and try again." };
  }

  // Per requesting IP, per hour.
  const ip = await requestIp();
  if (ip) {
    const fromIp = await db.phoneOtp.count({ where: { requestIp: ip, createdAt: { gte: hourAgo } } });
    if (fromIp >= SIGNUP_ATTEMPTS_PER_IP_PER_HOUR) return { ok: false, error: SITE_BUSY_MESSAGE };
  }

  // Whole site, per London day.
  const londonMidnight = londonDateTimeToUtc(formatLondon(new Date(), "yyyy-MM-dd"), "00:00");
  const today = await db.phoneOtp.count({ where: { createdAt: { gte: londonMidnight } } });
  if (today >= SITE_SIGNUP_CODES_PER_DAY) {
    console.warn(`[code-dm] site cap reached: ${today} codes today (cap ${SITE_SIGNUP_CODES_PER_DAY}); refusing.`);
    return { ok: false, error: SITE_BUSY_MESSAGE };
  }

  const code = randomInt(100_000, 1_000_000).toString();
  await db.phoneOtp.create({
    data: { phone: digits, code, expiresAt: new Date(Date.now() + CODE_TTL_MS), requestIp: ip },
  });

  const { from } = await queueCodeDm({ phone: digits, code, text: text(code), lang: await codeLangFromRequest() });
  return from ? { ok: true, from } : { ok: true };
}
