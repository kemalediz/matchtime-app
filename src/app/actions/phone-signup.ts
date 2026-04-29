"use server";

import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "@/lib/magic-link";
import { randomInt } from "node:crypto";

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
 * Rate limits (best-effort, per-phone):
 *   - ≤ 3 outstanding codes in the last hour
 *   - Code expires in 10 minutes
 *   - ≤ 5 verify attempts per code
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_OUTSTANDING_PER_HOUR = 3;
const MAX_ATTEMPTS = 5;

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

  const code = generateCode();
  await db.phoneOtp.create({
    data: {
      phone: digits,
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });

  // Queue a WhatsApp DM. We don't need an orgId here — BotJob requires
  // one, so we reuse the first bot-enabled org purely as a sender. The
  // shared Pi bot DMs any JID; the orgId on BotJob is just a dispatch
  // pointer. If none exists the DM never lands — client surfaces that.
  const senderOrg = await db.organisation.findFirst({
    where: { whatsappBotEnabled: true },
    select: { id: true },
  });
  if (!senderOrg) {
    return {
      ok: false,
      error:
        "MatchTime is still warming up — no active sender right now. Try again in a few minutes.",
    };
  }

  await db.botJob.create({
    data: {
      orgId: senderOrg.id,
      kind: "dm",
      phone: digits,
      text:
        `👋 Welcome to MatchTime${name ? `, ${name}` : ""}!\n\n` +
        `Your verification code: *${code}*\n\n` +
        `It expires in 10 minutes. If you didn't ask for this, just ignore the message.`,
    },
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
