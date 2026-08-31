/**
 * Email/password auth security semantics, against the ISOLATED embedded
 * Postgres. Run under tsx (not Playwright's transpiler) because the auth
 * server action imports the Prisma 7 generated client — same pattern as
 * lib-tests.ts. Invoked by e2e/api/auth-security.spec.ts; exits non-zero
 * with a readable message on any failure.
 *
 * What it pins:
 *   1. Nobody can set a password on someone else's passwordless account
 *      without proving they control the mailbox. (Every MatchTime user
 *      is passwordless — they sign in by WhatsApp magic link or phone
 *      OTP — so this is an account-takeover primitive, admins included.)
 *   2. The legitimate journey still works: sign up with an email that
 *      already has a passwordless account, enter the emailed code, and
 *      the password is set.
 *   3. The 6-digit verification code is attempt-capped and the code is
 *      burned on lockout, and code issuance is throttled per email —
 *      mirroring the phone-OTP flow, which already does this properly.
 *
 * Requires MT_E2E_DATABASE_URL (set by e2e/run.ts).
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  // No RESEND_API_KEY in the test env → sendVerificationEmail logs and
  // returns; nothing leaves the machine.

  const { db } = await import("@/lib/db");
  const bcrypt = (await import("bcryptjs")).default;
  const { signUpWithEmail, verifyEmail, resendVerification } = await import(
    "@/app/actions/auth"
  );

  let n = 0;
  const ok = (label: string) => {
    n++;
    console.log(`  ✓ ${label}`);
  };

  const TAG = "authsec-";
  const email = (slug: string) => `${TAG}${slug}@example.invalid`;

  async function wipe() {
    await db.verificationToken.deleteMany({ where: { identifier: { contains: TAG } } });
    await db.user.deleteMany({ where: { email: { contains: TAG } } });
  }

  /** Read the live 6-digit code for an email straight from the DB (the
   *  attacker cannot do this — it stands in for opening the mailbox). */
  async function codeFor(addr: string): Promise<string> {
    const row = await db.verificationToken.findFirst({
      where: { identifier: addr, expires: { gt: new Date() } },
    });
    assert.ok(row, `expected a verification code row for ${addr}`);
    return row.token;
  }

  async function expectThrows(fn: () => Promise<unknown>, re: RegExp, label: string) {
    let threw: Error | null = null;
    try {
      await fn();
    } catch (err) {
      threw = err as Error;
    }
    assert.ok(threw, `${label}: expected a rejection, got success`);
    assert.match(threw.message, re, label);
  }

  await wipe();

  // ── 1. Password injection onto a passwordless account ──────────────
  {
    const victim = email("victim");
    const v = await db.user.create({
      data: { email: victim, name: "Victim Admin", password: null },
    });

    // An unauthenticated attacker "signs up" with the victim's address.
    await signUpWithEmail({
      name: "Not The Victim",
      email: victim,
      password: "attacker-chosen-pw-1",
    });

    const after = await db.user.findUnique({ where: { id: v.id } });
    assert.equal(
      after?.password,
      null,
      "a caller who cannot read the victim's mailbox must NOT be able to set a password on their account",
    );
    ok("passwordless account: no password is written before the mailbox is proven");

    assert.equal(after?.emailVerified, null, "email must not be marked verified either");
    ok("passwordless account: emailVerified untouched");

    // The code went to the victim's mailbox, so the attacker is stuck.
    const codeRow = await db.verificationToken.findFirst({ where: { identifier: victim } });
    assert.ok(codeRow, "a verification code is still issued (to the real owner)");
    ok("verification code issued to the address owner");
  }

  // ── 2. The legitimate journey still works ─────────────────────────
  {
    const owner = email("owner");
    const u = await db.user.create({
      data: { email: owner, name: "Real Owner", password: null },
    });

    await signUpWithEmail({ name: "Real Owner", email: owner, password: "owner-password-1" });
    const code = await codeFor(owner);
    await verifyEmail(owner, code);

    const after = await db.user.findUnique({ where: { id: u.id } });
    assert.ok(after?.password, "password must be set once the emailed code is entered");
    assert.ok(
      await bcrypt.compare("owner-password-1", after!.password!),
      "the stored hash must match the password the owner chose",
    );
    assert.ok(after?.emailVerified, "email is verified by the same step");
    ok("legit journey: passwordless account + emailed code → password set and email verified");

    // Sign-in preconditions the credentials provider checks.
    assert.ok(after!.emailVerified && after!.password, "credentials sign-in preconditions met");
    ok("legit journey: credentials sign-in preconditions met");
  }

  // ── 3. Brand-new signup is unchanged ──────────────────────────────
  {
    const fresh = email("fresh");
    await signUpWithEmail({ name: "Fresh Signup", email: fresh, password: "fresh-password-1" });
    const created = await db.user.findUnique({ where: { email: fresh } });
    assert.ok(created, "a brand-new account is created");
    assert.ok(created!.password, "with its password set");
    assert.equal(created!.emailVerified, null, "but not yet verified");

    const code = await codeFor(fresh);
    await verifyEmail(fresh, code);
    const verified = await db.user.findUnique({ where: { email: fresh } });
    assert.ok(verified?.emailVerified, "code entry verifies the new account");
    ok("new signup → verify → usable account (unchanged)");
  }

  // ── 4. An account that already has a password is never overwritten ─
  {
    const taken = email("taken");
    await db.user.create({
      data: { email: taken, name: "Has Password", password: await bcrypt.hash("original-pw", 12) },
    });
    await expectThrows(
      () => signUpWithEmail({ name: "Has Password", email: taken, password: "hijack-pw-1" }),
      /already exists/i,
      "existing password-holder",
    );
    const still = await db.user.findUnique({ where: { email: taken } });
    assert.ok(await bcrypt.compare("original-pw", still!.password!), "password untouched");
    ok("account with a password: signup refused, hash untouched");
  }

  // ── 5. verifyEmail is attempt-capped and burns the code on lockout ─
  {
    const brute = email("brute");
    await db.user.create({ data: { email: brute, name: "Brute Target", password: null } });
    await signUpWithEmail({ name: "Brute Target", email: brute, password: "some-password-1" });
    const real = await codeFor(brute);

    const wrong = real === "000000" ? "111111" : "000000";
    let rejections = 0;
    let lockedOutAt = -1;
    for (let i = 1; i <= 8; i++) {
      try {
        await verifyEmail(brute, wrong);
        assert.fail("a wrong code must never verify");
      } catch (err) {
        const msg = (err as Error).message;
        if (/too many/i.test(msg)) {
          lockedOutAt = i;
          break;
        }
        rejections++;
      }
    }
    assert.ok(
      lockedOutAt > 0 && lockedOutAt <= 6,
      `verifyEmail must lock out after a handful of wrong codes (got ${rejections} unlimited rejections)`,
    );
    ok(`verifyEmail locks out on attempt ${lockedOutAt} (6-digit code is no longer brute-forceable)`);

    // The real code is dead too — an attacker cannot exhaust attempts and
    // then have the owner's code still standing.
    await expectThrows(() => verifyEmail(brute, real), /too many|invalid or expired/i, "code burned");
    const target = await db.user.findUnique({ where: { email: brute } });
    assert.equal(target?.password, null, "no password was set through the brute-force path");
    assert.equal(target?.emailVerified, null, "and the email was not verified");
    ok("locked-out code is burned; account state untouched");

    // The lockout targets the code, not the mailbox owner: a fresh code
    // (still inside the hourly issuance budget) lets the real owner in.
    await resendVerification(brute);
    const replacement = await codeFor(brute);
    await verifyEmail(brute, replacement);
    const recovered = await db.user.findUnique({ where: { email: brute } });
    assert.ok(recovered?.emailVerified, "owner can verify with a newly issued code");
    ok("a newly issued code clears the lockout for the legitimate owner");
  }

  // ── 6. Code issuance is throttled per email ───────────────────────
  {
    const spam = email("spam");
    await db.user.create({ data: { email: spam, name: "Spam Target", password: null } });
    // #1 (signup) + #2, #3 (resends) are allowed; the next must be refused.
    await signUpWithEmail({ name: "Spam Target", email: spam, password: "some-password-1" });
    await resendVerification(spam);
    await resendVerification(spam);
    await expectThrows(() => resendVerification(spam), /too many|wait/i, "resend throttle");
    await expectThrows(
      () => signUpWithEmail({ name: "Spam Target", email: spam, password: "some-password-2" }),
      /too many|wait/i,
      "signup re-issue throttle",
    );
    ok("code issuance throttled to a few per hour per address");
  }

  await wipe();
  await db.$disconnect();
  console.log(`\nOK — ${n} auth-security assertions passed`);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
