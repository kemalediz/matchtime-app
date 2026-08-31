/**
 * Email verification-code policy: issuance throttle, attempt cap, and the
 * deferred password-set that makes "set a password on an existing
 * account" require proof of mailbox control.
 *
 * Modelled on the phone-OTP flow (`src/app/actions/phone-signup.ts`),
 * which already does this properly: short expiry, a 5-attempt cap per
 * code, and a few codes per hour per identity.
 *
 * WHY THE ODD STORAGE: `PhoneOtp` has `attempts` / `usedAt` /
 * `createdAt` columns; `VerificationToken` (the NextAuth table the email
 * flow uses) has only `identifier`, `token` and `expires`, and this is a
 * hot fix on a live system — no schema change. So the counters live in
 * the same table under NAMESPACED identifiers that can never collide
 * with a real email address (they contain ":" before any "@", which a
 * zod-validated address cannot):
 *
 *   mt:evc-issue:<email>    one row per code issued, expires after 1h
 *                           → count of live rows = codes in the last hour
 *   mt:evc-attempt:<email>  one row per failed verification, expires
 *                           after the lockout window
 *   mt:evc-pwset:<email>    the bcrypt hash the caller asked to set,
 *                           applied only when the emailed code comes back
 *
 * The `token` column is globally unique, so every marker row carries a
 * random nonce.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "./db";

/** Codes that may be issued per address per hour (signup + resends). */
export const MAX_CODES_PER_HOUR = 3;
/** Wrong-code attempts before the code is burned and the address locked. */
export const MAX_VERIFY_ATTEMPTS = 5;

const ISSUE_WINDOW_MS = 60 * 60 * 1000;
const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;
/** A stashed password survives a resend or two, then dies on its own. */
const PENDING_PASSWORD_TTL_MS = 60 * 60 * 1000;

/** Namespace keys are case-folded so `Victim@x` and `victim@x` share one
 *  bucket — otherwise case-variation would mint unlimited codes into the
 *  same mailbox. */
function key(email: string): string {
  return email.trim().toLowerCase();
}

const issueId = (email: string) => `mt:evc-issue:${key(email)}`;
const attemptId = (email: string) => `mt:evc-attempt:${key(email)}`;
const pwsetId = (email: string) => `mt:evc-pwset:${key(email)}`;

async function countLive(identifier: string): Promise<number> {
  return db.verificationToken.count({
    where: { identifier, expires: { gt: new Date() } },
  });
}

async function mark(identifier: string, ttlMs: number): Promise<void> {
  await db.verificationToken.create({
    data: {
      identifier,
      token: `${identifier}#${randomUUID()}`,
      expires: new Date(Date.now() + ttlMs),
    },
  });
}

/**
 * Throw unless another code may be sent to this address right now.
 * Call BEFORE generating/sending, so a refusal costs nothing.
 */
export async function assertCanIssueCode(email: string): Promise<void> {
  // Opportunistic cleanup so the marker rows can't accumulate.
  await db.verificationToken.deleteMany({
    where: { identifier: issueId(email), expires: { lte: new Date() } },
  });
  if ((await countLive(issueId(email))) >= MAX_CODES_PER_HOUR) {
    throw new Error("Too many verification codes requested. Please wait an hour and try again.");
  }
}

/** Record that a code was just sent to this address. */
export async function recordCodeIssued(email: string): Promise<void> {
  await mark(issueId(email), ISSUE_WINDOW_MS);
}

/** How many wrong codes have been submitted for this address recently. */
export async function countFailedAttempts(email: string): Promise<number> {
  await db.verificationToken.deleteMany({
    where: { identifier: attemptId(email), expires: { lte: new Date() } },
  });
  return countLive(attemptId(email));
}

/** Record a wrong code; returns the new live attempt count. */
export async function recordFailedAttempt(email: string): Promise<number> {
  await mark(attemptId(email), LOCKOUT_WINDOW_MS);
  return countLive(attemptId(email));
}

/** Reset the wrong-attempt counter. Called when a FRESH code is issued,
 *  so "request a new code" is honest advice after a lockout. Issuance is
 *  itself capped, so the guess budget stays at
 *  MAX_CODES_PER_HOUR x MAX_VERIFY_ATTEMPTS per hour. */
export async function clearFailedAttempts(email: string): Promise<void> {
  await db.verificationToken.deleteMany({ where: { identifier: attemptId(email) } });
}

/** Invalidate every outstanding code for an address (used on lockout and
 *  on success). Marker rows are namespaced, so this only hits codes. */
export async function burnCodes(email: string): Promise<void> {
  await db.verificationToken.deleteMany({ where: { identifier: email } });
}

/** Clear the throttle/lockout state after a successful verification. */
export async function clearVerificationState(email: string): Promise<void> {
  await db.verificationToken.deleteMany({
    where: { identifier: { in: [attemptId(email), issueId(email)] } },
  });
}

/**
 * Stash a bcrypt hash to be applied to the account only once the emailed
 * code comes back. Replaces any previous stash for the address.
 */
export async function stashPendingPassword(email: string, hash: string): Promise<void> {
  await db.verificationToken.deleteMany({ where: { identifier: pwsetId(email) } });
  await db.verificationToken.create({
    data: {
      identifier: pwsetId(email),
      token: `${randomUUID()}|${hash}`,
      expires: new Date(Date.now() + PENDING_PASSWORD_TTL_MS),
    },
  });
}

/** Consume the stashed hash, if any is still live. */
export async function takePendingPassword(email: string): Promise<string | null> {
  const row = await db.verificationToken.findFirst({
    where: { identifier: pwsetId(email), expires: { gt: new Date() } },
    orderBy: { expires: "desc" },
  });
  await db.verificationToken.deleteMany({ where: { identifier: pwsetId(email) } });
  if (!row) return null;
  const hash = row.token.slice(row.token.indexOf("|") + 1);
  return hash || null;
}

/** Length-safe constant-time string comparison for the 6-digit code. */
export function codesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
