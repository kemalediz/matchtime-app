"use server";

/**
 * Post-signin "claim my player account" flow.
 *
 * Players who have been added to an org via WhatsApp already have a
 * synthetic User row keyed off their phone (created either by the
 * onboarding wizard import, or auto-provisioned by the live message
 * resolver, or matched at OTP signup time). When such a player tries
 * to sign in via Google or email/password, NextAuth creates a brand
 * new User keyed off their email — disconnected from the bot-tracked
 * record. They land on the dashboard with zero stats.
 *
 * This action takes the user through a phone-OTP claim:
 *   1. startClaimAccount(phone) — issue a 6-digit code, DM via the
 *      shared MatchTime bot.
 *   2. verifyClaimAccount(phone, code) — validate, find the existing
 *      User by phone, merge the orphan's OAuth identity (email +
 *      name + image + Account rows) into the existing record,
 *      delete the orphan. Caller signs out so the JWT re-issues
 *      against the merged user.
 *
 * If no existing User matches the verified phone, the orphan keeps
 * its row, gets the phone stored, and continues to /welcome as a
 * fresh admin starting a new club.
 */
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { queuePlatformDm } from "@/lib/platform-jobs";
import { randomInt } from "node:crypto";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_OUTSTANDING_PER_HOUR = 3;
const MAX_ATTEMPTS = 5;

function generateCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

export async function startClaimAccount(
  phoneInput: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Not signed in" };

  const phone = normalisePhone(phoneInput);
  if (!phone) {
    return {
      ok: false,
      error: "Phone number looks invalid. Use full international format (e.g. +44…)",
    };
  }
  const digits = phone.replace(/^\+/, "");

  // Rate-limit per phone — ≤3 outstanding codes / hour. Same rules
  // as the phone-signup OTP flow so a flood of taps can't spam DMs.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db.phoneOtp.count({
    where: { phone: digits, createdAt: { gte: hourAgo } },
  });
  if (recent >= MAX_OUTSTANDING_PER_HOUR) {
    return {
      ok: false,
      error: "Too many requests. Please wait a few minutes and try again.",
    };
  }

  const code = generateCode();
  await db.phoneOtp.create({
    data: {
      phone: digits,
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });

  // A PlatformJob, not a BotJob under a borrowed bot-enabled org: the code
  // must go out even when every club's bot is switched off (self-join
  // slice 3; src/lib/platform-jobs.ts).
  await queuePlatformDm({
    phone: digits,
    purpose: "otp",
    text:
      `🔐 *MatchTime: claim your account*\n\n` +
      `Your verification code: *${code}*\n\n` +
      `It expires in 10 minutes. If you didn't request this, just ignore this message.`,
  });

  return { ok: true };
}

export async function verifyClaimAccount(args: {
  phone: string;
  code: string;
}): Promise<
  | { ok: true; claimed: boolean }
  | { ok: false; error: string }
> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Not signed in" };

  const phone = normalisePhone(args.phone);
  if (!phone) return { ok: false, error: "Phone number looks invalid" };
  const digits = phone.replace(/^\+/, "");
  const code = args.code.trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Code must be 6 digits" };

  const otp = await db.phoneOtp.findFirst({
    where: { phone: digits, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return { ok: false, error: "Code expired, request a new one" };

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

  // OTP good — consume it.
  await db.phoneOtp.update({
    where: { id: otp.id },
    data: { usedAt: new Date() },
  });

  const orphanId = session.user.id;
  const orphan = await db.user.findUnique({ where: { id: orphanId } });
  if (!orphan) return { ok: false, error: "Current user not found" };

  const matched = await db.user.findUnique({ where: { phoneNumber: phone } });

  if (!matched || matched.id === orphanId) {
    // No existing player record — store the verified phone on the
    // current user and let them continue to /welcome as a new admin
    // starting a fresh club. We DO NOT mark onboarded=true here:
    // /welcome still asks for name and is the canonical "you're
    // about to admin a club" handshake.
    await db.user.update({
      where: { id: orphanId },
      data: { phoneNumber: phone },
    });
    return { ok: true, claimed: false };
  }

  // Found an existing User with this phone. Merge: keep `matched`
  // (it has all the attendance/team/rating history), absorb orphan's
  // OAuth identity (email + name + image + Account rows), then
  // delete orphan.
  //
  // Order matters because of unique constraints:
  //   1. Free orphan's email → so matched can take it.
  //   2. Copy email/name/image to matched.
  //   3. Transfer Account rows from orphan → matched (so future
  //      Google sign-ins map to the merged user).
  //   4. Delete orphan. Sessions cascade-delete; Account rows are
  //      already moved.
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: orphanId },
      data: { email: `merged-${orphanId}-${Date.now()}@matchtime.local` },
    });
    await tx.user.update({
      where: { id: matched.id },
      data: {
        email: orphan.email,
        name: orphan.name ?? matched.name,
        image: orphan.image ?? matched.image,
        onboarded: true,
      },
    });
    await tx.account.updateMany({
      where: { userId: orphanId },
      data: { userId: matched.id },
    });
    await tx.user.delete({ where: { id: orphanId } });
  });

  return { ok: true, claimed: true };
}
