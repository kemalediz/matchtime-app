"use server";

import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "@/lib/magic-link";
import { randomInt } from "node:crypto";
import { headers } from "next/headers";
import { queuePlatformDm } from "@/lib/platform-jobs";
import { formatLondon, londonDateTimeToUtc } from "@/lib/london-time";
import {
  SIGNUP_ATTEMPTS_PER_IP_PER_HOUR,
  SITE_BUSY_MESSAGE,
  SITE_SIGNUP_CODES_PER_DAY,
} from "@/lib/signup-caps";

/**
 * Phone-number signup via WhatsApp OTP.
 *
 * Flow:
 *   1. User enters phone + (optional) name at /signup.
 *   2. startPhoneSignup issues a 6-digit code, stores it, and queues a
 *      WhatsApp DM via BotJob (kind="dm"). No User row is created yet
 *      — we don't want a flood of half-baked accounts from typos.
 *   3. User enters the code at /signup/verify.
 *   4. verifyPhoneSignup validates, creates / reuses the User row, and
 *      returns a magic-link token. The page redirects to /r/<token>
 *      which signs them in via the existing magic-link credentials
 *      provider and lands them on /onboarding.
 *
 * Rate limits (best-effort):
 *   - ≤ 3 outstanding codes per phone in the last hour
 *   - ≤ SIGNUP_ATTEMPTS_PER_IP_PER_HOUR codes per requesting IP in the
 *     last hour (self-join plan section 7, cap 3; first x-forwarded-for
 *     hop; no header, no IP cap)
 *   - ≤ SITE_SIGNUP_CODES_PER_DAY codes per London day, whole site (cap 2).
 *     Counted from PhoneOtp, which claim-account codes share, so the cap
 *     is conservative.
 *   - Code expires in 10 minutes
 *   - ≤ 5 verify attempts per code
 *
 * The code DM is a PlatformJob (purpose "otp"), polled by the Pi whatever
 * any club's bot switch says (self-join slice 3). It used to be a BotJob
 * under "the first bot-enabled org", borrowed as a sender, so muting the
 * only live club stopped every sign-up.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_OUTSTANDING_PER_HOUR = 3;
const MAX_ATTEMPTS = 5;
const SITE_BUSY = SITE_BUSY_MESSAGE;

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

function generateCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

export async function startPhoneSignup(args: {
  phone: string;
  name: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const phone = normalisePhone(args.phone);
  if (!phone) return { ok: false, error: "Phone number looks invalid. Use full international format (e.g. +44…)" };
  const digits = phone.replace(/^\+/, "");
  const name = args.name.trim();
  if (name.length < 2) return { ok: false, error: "Tell us your name" };

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db.phoneOtp.count({
    where: { phone: digits, createdAt: { gte: hourAgo } },
  });
  if (recent >= MAX_OUTSTANDING_PER_HOUR) {
    return { ok: false, error: "Too many requests. Please wait a bit and try again." };
  }

  // Cap 3: per requesting IP, per hour.
  const ip = await requestIp();
  if (ip) {
    const fromIp = await db.phoneOtp.count({
      where: { requestIp: ip, createdAt: { gte: hourAgo } },
    });
    if (fromIp >= SIGNUP_ATTEMPTS_PER_IP_PER_HOUR) return { ok: false, error: SITE_BUSY };
  }

  // Cap 2: whole site, per London day.
  const now = new Date();
  const londonMidnight = londonDateTimeToUtc(formatLondon(now, "yyyy-MM-dd"), "00:00");
  const today = await db.phoneOtp.count({ where: { createdAt: { gte: londonMidnight } } });
  if (today >= SITE_SIGNUP_CODES_PER_DAY) {
    console.warn(
      `[phone-signup] site cap reached: ${today} sign-up codes today (cap ${SITE_SIGNUP_CODES_PER_DAY}); refusing.`,
    );
    return { ok: false, error: SITE_BUSY };
  }

  const code = generateCode();
  await db.phoneOtp.create({
    data: {
      phone: digits,
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      requestIp: ip,
    },
  });

  await queuePlatformDm({
    phone: digits,
    purpose: "otp",
    text:
      `👋 Welcome to MatchTime${name ? `, ${name}` : ""}!\n\n` +
      `Your verification code: *${code}*\n\n` +
      `It expires in 10 minutes. If you didn't ask for this, just ignore the message.`,
  });

  return { ok: true };
}

export async function verifyPhoneSignup(args: {
  phone: string;
  code: string;
  name: string;
}): Promise<
  | { ok: true; magicLinkToken: string; isExistingPlayer: boolean }
  | { ok: false; error: string }
> {
  const phone = normalisePhone(args.phone);
  if (!phone) return { ok: false, error: "Phone number looks invalid" };
  const digits = phone.replace(/^\+/, "");
  const code = args.code.trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Code must be 6 digits" };
  const name = args.name.trim();

  const otp = await db.phoneOtp.findFirst({
    where: { phone: digits, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return { ok: false, error: "Code expired — request a new one" };

  if (otp.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: "Too many wrong attempts. Request a new code." };
  }

  if (otp.code !== code) {
    await db.phoneOtp.update({
      where: { id: otp.id },
      data: { attempts: otp.attempts + 1 },
    });
    return { ok: false, error: "Wrong code" };
  }

  // Mark consumed + find-or-create user.
  await db.phoneOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });

  let user = await db.user.findUnique({ where: { phoneNumber: phone } });
  let createdNew = false;
  if (!user) {
    // Synthetic email keeps User.email unique. They can claim a real
    // email later via profile settings if they want Google login too.
    const slug = (name || "player")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "player";
    user = await db.user.create({
      data: {
        name: name || null,
        phoneNumber: phone,
        email: `phone+${slug}-${Date.now().toString(36)}@matchtime.local`,
        // Phone is verified — that's a complete handshake. Mark them
        // onboarded so /page.tsx doesn't bounce them through /welcome
        // (which is the "give us your name + phone" form they just
        // effectively completed).
        onboarded: true,
        isActive: true,
      },
    });
    createdNew = true;
  } else {
    // Existing User found via phone — likely a player added through
    // a club's WhatsApp group. Ensure name is set if they provided
    // one + flip onboarded so the redirect logic doesn't push them
    // through /welcome.
    const patch: { name?: string; onboarded?: boolean } = {};
    if (name && !user.name) patch.name = name;
    if (!user.onboarded) patch.onboarded = true;
    if (Object.keys(patch).length > 0) {
      user = await db.user.update({ where: { id: user.id }, data: patch });
    }
  }

  // Where they go next depends on whether they're already a member of
  // some org or not:
  //   - existing player (memberships > 0) → land on dashboard so
  //     they see their stats. Don't push them through /onboarding —
  //     they're not starting a new club.
  //   - brand-new (no memberships) → /onboarding wizard for new club.
  const memberships = await db.membership.count({
    where: { userId: user.id, leftAt: null },
  });
  const nextPath = memberships > 0 ? "/" : "/onboarding";

  // Issue a short-lived magic-link token — the client redirects to
  // /r/<token>, the existing magic-link credentials provider signs
  // them in, and deep-links them to nextPath.
  const token = signMagicLinkToken({
    userId: user.id,
    purpose: "sign-in",
    nextPath,
    ttlSeconds: 300, // 5 minutes — plenty to bounce through /r/*
  });

  return { ok: true, magicLinkToken: token, isExistingPlayer: !createdNew && memberships > 0 };
}
