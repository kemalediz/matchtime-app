"use server";

import { db } from "@/lib/db";
import { signUpSchema } from "@/lib/validations";
import { sendVerificationEmail } from "@/lib/email";
import {
  MAX_VERIFY_ATTEMPTS,
  assertCanIssueCode,
  burnCodes,
  clearFailedAttempts,
  clearVerificationState,
  codesMatch,
  countFailedAttempts,
  recordCodeIssued,
  recordFailedAttempt,
  stashPendingPassword,
  takePendingPassword,
} from "@/lib/email-verification";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const CODE_TTL_MS = 10 * 60 * 1000;

/** Mint a fresh 6-digit code for an address, replacing any outstanding
 *  one, and email it. Callers must have passed the issuance throttle. */
async function issueCode(email: string, name?: string | null): Promise<void> {
  const code = crypto.randomInt(100000, 999999).toString();
  await burnCodes(email);
  await db.verificationToken.create({
    data: { identifier: email, token: code, expires: new Date(Date.now() + CODE_TTL_MS) },
  });
  await recordCodeIssued(email);
  // A fresh code starts a fresh attempt budget — otherwise a locked-out
  // user is told to request a new code and it does not help them.
  await clearFailedAttempts(email);
  await sendVerificationEmail(email, code, name);
}

export async function signUpWithEmail(formData: {
  name: string;
  email: string;
  password: string;
}) {
  const parsed = signUpSchema.parse(formData);

  const existing = await db.user.findUnique({
    where: { email: parsed.email },
  });

  if (existing?.password) {
    throw new Error("An account with this email already exists. Please sign in.");
  }

  await assertCanIssueCode(parsed.email);

  const hashedPassword = await bcrypt.hash(parsed.password, 12);

  if (existing) {
    // SECURITY (2026-08-31): this used to write the password straight onto
    // the existing account. Every MatchTime user is passwordless — they
    // sign in by WhatsApp magic link or phone OTP — and their addresses
    // are derivable, so that let an unauthenticated caller plant a
    // password on anyone's account, admins included. Nothing is written to
    // the account here now: the chosen password is stashed and applied
    // only when the code we email to that address comes back, which is
    // proof the caller controls the mailbox.
    await stashPendingPassword(parsed.email, hashedPassword);
  } else {
    await db.user.create({
      data: {
        name: parsed.name,
        email: parsed.email,
        password: hashedPassword,
      },
    });
  }

  await issueCode(parsed.email, parsed.name);

  return { success: true };
}

export async function verifyEmail(email: string, code: string) {
  const supplied = String(code ?? "").trim();

  // Lockout first: a burned code must not be re-openable by guessing.
  if ((await countFailedAttempts(email)) >= MAX_VERIFY_ATTEMPTS) {
    await burnCodes(email);
    throw new Error("Too many incorrect attempts. Request a new code.");
  }

  // Fetch by identifier and compare in constant time, rather than letting
  // the database answer "is this the code?" as a lookup.
  const live = await db.verificationToken.findMany({
    where: { identifier: email, expires: { gt: new Date() } },
  });
  const token = live.find((t) => codesMatch(t.token, supplied));

  if (!token) {
    const attempts = await recordFailedAttempt(email);
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await burnCodes(email);
      throw new Error("Too many incorrect attempts. Request a new code.");
    }
    throw new Error("Invalid or expired verification code");
  }

  // Correct code = proof of mailbox control. Apply the password the
  // signup form asked for, if one is still pending.
  const pendingPassword = await takePendingPassword(email);

  await db.user.update({
    where: { email },
    data: {
      emailVerified: new Date(),
      ...(pendingPassword ? { password: pendingPassword } : {}),
    },
  });

  await burnCodes(email);
  await clearVerificationState(email);

  return { success: true };
}

export async function resendVerification(email: string) {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error("No account found with this email");
  if (user.emailVerified) throw new Error("Email is already verified");

  await assertCanIssueCode(email);
  await issueCode(email, user.name);

  return { success: true };
}
