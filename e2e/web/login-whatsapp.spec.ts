/**
 * SIGN IN WITH WHATSAPP: the only way in (2026-10-11).
 *
 * Reported live by the owner: an organiser who signed up with a phone
 * number was later shown /login, which offered only email + password and
 * Google. A phone account has neither. "the user shouldn't be signing up
 * again. nobody would do that. any admin would like to sign in again to
 * see the dashboard from any device".
 *
 * Driven through the real pages, with the code read from the test DB
 * (the Pi is not in the loop):
 *   - /login offers WhatsApp and nothing else; the retired email pages
 *     redirect; Google appears only at /login?via=google;
 *   - an organiser who signed up by phone signs out, is sent to /login by
 *     a protected page, signs in with a code and lands back on that page;
 *   - a number with no account gets a code like anyone else, and is told
 *     there is no account only after entering it; no user is created;
 *   - a wrong code signs nobody in; an off-site callbackUrl is ignored;
 *   - the button stays busy until the next page has loaded.
 *
 * Deterministic: no model is involved anywhere in this flow.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb, mintToken } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const ORGANISER_PHONE = "+447700900981";
const UNKNOWN_PHONE = "+447700900982";
const digits = (phone: string) => phone.slice(1);

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  // Leave the world as the next spec expects it.
  resetDb();
});

/** The newest code issued for a phone, straight from the test DB. */
async function latestCode(phone: string): Promise<string> {
  const otp = await testDb().one<{ code: string }>(
    `SELECT code FROM "PhoneOtp" WHERE phone = $1 AND "usedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(phone)],
  );
  expect(otp?.code).toMatch(/^\d{6}$/);
  return otp!.code;
}

const users = (phone: string) =>
  testDb().count(`SELECT COUNT(*) FROM "User" WHERE "phoneNumber" = $1`, [phone]);

/** Fill the phone on /login and ask for a code. */
async function askForCode(page: Page, phone: string) {
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Sign in with WhatsApp" }).click();
  await expect(page.getByLabel("6 digit code")).toBeVisible();
}

test("/login offers WhatsApp and nothing else", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in with WhatsApp" })).toBeVisible();
  await expect(page.getByLabel("Phone number")).toBeVisible();

  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /google/i })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/password|google|email/i);
  // No name is asked for: this is not sign-up.
  await expect(page.getByText("Your name")).toHaveCount(0);

  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  await page.waitForURL("**/signup");
});

test("/signup points an existing user at /login", async ({ page }) => {
  await page.goto("/signup");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/login");
  await expect(page.getByRole("button", { name: "Sign in with WhatsApp" })).toBeVisible();
});

test("the retired email pages redirect", async ({ page }) => {
  await page.goto("/signup-email");
  expect(new URL(page.url()).pathname).toBe("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  await page.goto("/verify-email?email=someone%40example.com");
  expect(new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByRole("button", { name: "Sign in with WhatsApp" })).toBeVisible();
});

test("Google is shown only at /login?via=google, and says why it refused", async ({ page }) => {
  await page.goto("/login?via=google");
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  // WhatsApp is still first.
  await expect(page.getByRole("button", { name: "Sign in with WhatsApp" })).toBeVisible();
  await expect(page.getByText("not linked")).toHaveCount(0);

  // Where the sign-in gate sends an unknown Google account.
  await page.goto("/login?via=google&error=not-linked");
  await expect(page.getByText("That Google account is not linked to a MatchTime account.")).toBeVisible();

  // The reason alone does not reveal the button.
  await page.goto("/login?error=not-linked");
  await expect(page.getByRole("button", { name: /google/i })).toHaveCount(0);
});

test("email + password is not a sign-in any more", async ({ request }) => {
  const res = await request.get("/api/auth/providers");
  expect(res.status()).toBe(200);
  expect(Object.keys(await res.json()).sort()).toEqual(["google", "magic-link"]);
});

test("an organiser who signed up by phone signs out, then signs back in with WhatsApp", async ({ page }) => {
  const db = testDb();

  // ── Sign up by phone, exactly as an organiser does ──
  await page.goto("/signup");
  await page.getByPlaceholder("Kemal Ediz").fill("Olive Organiser");
  await page.getByPlaceholder("+44 7xxx xxxxxx").fill(ORGANISER_PHONE);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByPlaceholder("123456")).toBeVisible();
  await page.getByPlaceholder("123456").fill(await latestCode(ORGANISER_PHONE));
  await page.getByRole("button", { name: /verify/i }).click();
  await page.waitForURL((url) => url.pathname !== "/signup", { timeout: 30_000 });

  const user = await db.one<{ id: string; email: string; password: string | null }>(
    `SELECT id, email, password FROM "User" WHERE "phoneNumber" = $1`,
    [ORGANISER_PHONE],
  );
  // A phone account: a made-up email and no password, so WhatsApp is its
  // only way back in.
  expect(user?.email).toMatch(/@matchtime\.local$/);
  expect(user?.password).toBeNull();

  // They run a club.
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'OWNER')`, [
    "e2e-login-wa-membership",
    user!.id,
    ORG_ID,
  ]);

  // ── Sign out ──
  await page.context().clearCookies();
  await page.goto("/admin");
  await page.waitForURL("**/login?callbackUrl=%2Fadmin");

  // ── Sign in with WhatsApp: phone, code, in. No name asked. ──
  await expect(page.getByText("Your name")).toHaveCount(0);
  await askForCode(page, ORGANISER_PHONE);
  const code = await latestCode(ORGANISER_PHONE);
  // The message is a sign-in message, on the platform channel.
  const job = await db.one<{ purpose: string; text: string }>(
    `SELECT purpose, text FROM "PlatformJob" WHERE phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [digits(ORGANISER_PHONE)],
  );
  expect(job?.purpose).toBe("otp");
  expect(job?.text).toContain(`Your MatchTime sign-in code: *${code}*`);

  await page.getByLabel("6 digit code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // ── Their club's admin page ──
  await page.waitForURL("**/admin", { timeout: 30_000 });
  await expect(page.getByText("E2E Test FC").first()).toBeVisible();

  // Still one account for that number, and the code is spent.
  expect(await users(ORGANISER_PHONE)).toBe(1);
  expect(
    await db.count(`SELECT COUNT(*) FROM "PhoneOtp" WHERE phone = $1 AND "usedAt" IS NULL`, [digits(ORGANISER_PHONE)]),
  ).toBe(0);
});

test("the Sign in button stays busy until the next page has loaded", async ({ page }) => {
  await page.goto("/login");
  await askForCode(page, ORGANISER_PHONE);
  await page.getByLabel("6 digit code").fill(await latestCode(ORGANISER_PHONE));

  // Hold the dashboard so the pending navigation can be looked at.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let dashboardRequests = 0;
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      dashboardRequests++;
      await held;
      await route.continue();
    },
  );

  const button = page.locator('form button[type="submit"]');
  await button.click();
  await expect.poll(() => dashboardRequests, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500); // let any re-render after the action settle
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("Signing in…");

  release();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  // Signed in: the dashboard, not the landing page.
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);
});

test("a number with no account is told so only after a correct code, and no user is created", async ({ page }) => {
  const db = testDb();
  expect(await users(UNKNOWN_PHONE)).toBe(0);

  await page.goto("/login");
  // Asking for a code looks exactly as it does for a real account: the
  // code screen, and a code really is sent.
  await askForCode(page, UNKNOWN_PHONE);
  await expect(page.getByText(/no MatchTime account/i)).toHaveCount(0);
  expect(await db.count(`SELECT COUNT(*) FROM "PlatformJob" WHERE phone = $1`, [digits(UNKNOWN_PHONE)])).toBe(1);

  // A wrong code says "Wrong code", as for any number.
  const code = await latestCode(UNKNOWN_PHONE);
  const wrong = code === "000000" ? "111111" : "000000";
  await page.getByLabel("6 digit code").fill(wrong);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Wrong code")).toBeVisible();
  await expect(page.getByText(/no MatchTime account/i)).toHaveCount(0);

  // The right code: now, and only now, the answer.
  await page.getByLabel("6 digit code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("There is no MatchTime account for this number.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up to create one" })).toHaveAttribute("href", "/signup");

  // Nothing was created, and nobody is signed in.
  expect(await users(UNKNOWN_PHONE)).toBe(0);
  expect(new URL(page.url()).pathname).toBe("/login");
  await page.goto("/admin");
  await page.waitForURL("**/login**");
});

test("a wrong code signs nobody in", async ({ page }) => {
  // This number has had 3 codes this hour (sign-up and two sign-ins),
  // which is the per-phone cap, shared between sign-up and sign-in.
  await page.goto("/login");
  await page.getByLabel("Phone number").fill(ORGANISER_PHONE);
  await page.getByRole("button", { name: "Sign in with WhatsApp" }).click();
  await expect(page.getByText("Too many requests. Please wait a bit and try again.")).toBeVisible();
  await testDb().run(`DELETE FROM "PhoneOtp" WHERE phone = $1`, [digits(ORGANISER_PHONE)]);

  await askForCode(page, ORGANISER_PHONE);
  const code = await latestCode(ORGANISER_PHONE);
  await page.getByLabel("6 digit code").fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Wrong code")).toBeVisible();
  // The button is usable again after a failure.
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.goto("/admin");
  await page.waitForURL("**/login**");
});

test("an off-site callbackUrl is ignored", async ({ page }) => {
  await page.goto(`/login?callbackUrl=${encodeURIComponent("https://evil.example/admin")}`);
  await askForCode(page, ORGANISER_PHONE);
  await page.getByLabel("6 digit code").fill(await latestCode(ORGANISER_PHONE));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  expect(new URL(page.url()).host).not.toContain("evil.example");
});

// ── An expired signed link (the setup DM's and the reminder's last 7 days) ──

test("an expired signed link lands on sign-in with a notice, and signing in carries on to the page it was for", async ({ page }) => {
  const db = testDb();
  const user = await db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [ORGANISER_PHONE]);
  await db.run(`DELETE FROM "PhoneOtp" WHERE phone = $1`, [digits(ORGANISER_PHONE)]);
  await page.context().clearCookies();

  const token = mintToken(user!.id, { nextPath: "/admin/settings", ttlSeconds: -60 });
  await page.goto(`/r/${token}`);
  await page.waitForURL("**/login?expired=1&callbackUrl=%2Fadmin%2Fsettings", { timeout: 30_000 });
  await expect(page.getByTestId("login-link-expired")).toHaveText(
    "That link has expired. Sign in with your WhatsApp number to carry on.",
  );
  // Not the dead end it used to be.
  await expect(page.locator("body")).not.toContainText("isn't valid any more");
  // Nobody was signed in by the old link.
  expect((await page.context().cookies()).some((c) => /session-token/.test(c.name))).toBe(false);

  await askForCode(page, ORGANISER_PHONE);
  await page.getByLabel("6 digit code").fill(await latestCode(ORGANISER_PHONE));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Straight to the page the link was for, not the home page.
  await page.waitForURL("**/admin/settings", { timeout: 30_000 });
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
});

test("an expired SHORT link does the same, in the club's language", async ({ page }) => {
  const db = testDb();
  const user = await db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [ORGANISER_PHONE]);
  await page.context().clearCookies();
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  const token = mintToken(user!.id, { nextPath: "/admin/settings#go-live", ttlSeconds: -60 });
  await db.run(`INSERT INTO "ShortLink" (code, token, "expiresAt", "createdAt") VALUES ('e2eExpired1', $1, $2::timestamp, now())`, [
    token,
    new Date(Date.now() - 60_000).toISOString(),
  ]);
  try {
    await page.goto("/r/e2eExpired1");
    await page.waitForURL("**/login?expired=1&lang=tr&callbackUrl=%2Fadmin%2Fsettings%23go-live", { timeout: 30_000 });
    await expect(page.getByTestId("login-link-expired")).toHaveText(
      "Bu bağlantının süresi doldu. Devam etmek için WhatsApp numaranızla giriş yapın.",
    );
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("a link that was never ours still gets the plain error, and no sign-in notice is offered for it", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/r/neverACode");
  await expect(page.getByText("This link isn't valid any more. It may have expired or already been used.")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/r/neverACode");
  // A forged long token is not "expired" either.
  const forged = mintToken("e2e-nobody", { nextPath: "/admin", ttlSeconds: -60 }).split(".")[0] + ".AAAA";
  await page.goto(`/r/${forged}`);
  await expect(page.getByText("This link isn't valid any more. It may have expired or already been used.")).toBeVisible({ timeout: 30_000 });
});
