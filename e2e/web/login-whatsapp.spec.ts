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
import { test, expect, resetDb, mintToken, U } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E_BASE_URL } from "../helpers/env";
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
// and what a sign-in may be sent to afterwards (security review of PR #248).

const CLUB_B = "e2e-login-club-b";

/** No code is waiting, and no hourly cap is in the way. */
const freshCodes = () => testDb().run(`DELETE FROM "PhoneOtp"`);

/** Phone, code, in: a REAL sign-in on the page as it stands. */
async function signInOnPage(page: Page, phone: string) {
  await freshCodes();
  await askForCode(page, phone);
  await page.getByLabel("6 digit code").fill(await latestCode(phone));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

const organiserId = async () =>
  (await testDb().one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [ORGANISER_PHONE]))!.id;
const sessionUserId = async (page: Page) => (await (await page.request.get("/api/auth/session")).json())?.user?.id ?? null;
const pinnedClub = async (page: Page) => (await page.context().cookies()).find((c) => c.name === "orgId")?.value ?? null;
const onOurSite = (page: Page) => new URL(page.url()).origin === new URL(E2E_BASE_URL).origin;

test("an expired signed link lands on sign-in with a notice, and signing in carries on to the page it was for", async ({ page }) => {
  const userId = await organiserId();
  await page.context().clearCookies();

  const token = mintToken(userId, { nextPath: "/admin/settings", ttlSeconds: -60 });
  await page.goto(`/r/${token}`);
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
  // The link itself is all that is carried: no page, no club, no language.
  const q = new URL(page.url()).searchParams;
  expect([...q.keys()].sort()).toEqual(["expired", "link"]);
  expect(q.get("link")).toBe(token);
  await expect(page.getByTestId("login-link-expired")).toHaveText(
    "That link has expired. Sign in with your WhatsApp number to carry on.",
  );
  await expect(page.locator("body")).not.toContainText("isn't valid");
  // Nobody was signed in by the old link.
  expect(await sessionUserId(page)).toBeNull();

  await signInOnPage(page, ORGANISER_PHONE);
  // Straight to the page the link was for, not the home page.
  await page.waitForURL("**/admin/settings", { timeout: 30_000 });
  await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 30_000 });
  expect(await sessionUserId(page)).toBe(userId);
});

test("an expired SHORT link does the same; the notice is in the BROWSER's language, and the server's answer names nothing", async ({ browser }) => {
  const db = testDb();
  const userId = await organiserId();
  const token = mintToken(userId, { nextPath: "/billing/org_secret_1", orgId: ORG_ID, ttlSeconds: -60 });
  await db.run(`INSERT INTO "ShortLink" (code, token, "expiresAt", "createdAt") VALUES ('e2eExpired1', $1, $2::timestamp, now())`, [
    token,
    new Date(Date.now() - 60_000).toISOString(),
  ]);
  const ctx = await browser.newContext({ locale: "tr-TR" });
  const page = await ctx.newPage();

  // What the public endpoint says about an expired code: the word, only.
  const api = await page.request.get("/api/r/e2eExpired1");
  expect(api.status()).toBe(410);
  expect(await api.json()).toEqual({ error: "expired" });
  // Unknown codes are 404, as they always were.
  expect((await page.request.get("/api/r/neverACode")).status()).toBe(404);

  await page.goto("/r/e2eExpired1");
  await page.waitForURL("**/login?expired=1&link=e2eExpired1", { timeout: 30_000 });
  expect(page.url()).not.toMatch(/billing|org_secret|lang=|callbackUrl/);
  await expect(page.getByTestId("login-link-expired")).toHaveText(
    "Bu bağlantının süresi doldu. Devam etmek için WhatsApp numaranızla giriş yapın.",
  );
  await ctx.close();
});

test("a link that was never ours gets the plain card, which no longer claims it was 'already used'", async ({ page, browser }) => {
  await page.context().clearCookies();
  await page.goto("/r/neverACode");
  await expect(page.getByTestId("link-invalid")).toHaveText("This link isn't valid.", { timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText("already been used");
  await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  expect(new URL(page.url()).pathname).toBe("/r/neverACode");
  // A forged long token is not "expired" either.
  const forged = mintToken("e2e-nobody", { nextPath: "/admin", ttlSeconds: -60 }).split(".")[0] + ".AAAA";
  await page.goto(`/r/${forged}`);
  await expect(page.getByTestId("link-invalid")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toMatch(/^\/r\//);

  const ctx = await browser.newContext({ locale: "tr-TR" });
  const trPage = await ctx.newPage();
  await trPage.goto("/r/neverACode");
  await expect(trPage.getByTestId("link-invalid")).toHaveText("Bu bağlantı geçerli değil.", { timeout: 30_000 });
  await expect(trPage.getByRole("link", { name: "Giriş sayfasına git" })).toBeVisible();
  await ctx.close();
});

test("fix 6: an expired token posted straight to the sign-in callback gets no session; a live one does", async ({ browser }) => {
  const userId = await organiserId();
  const post = async (token: string) => {
    const ctx = await browser.newContext();
    const { csrfToken } = await (await ctx.request.get("/api/auth/csrf")).json();
    const res = await ctx.request.post("/api/auth/callback/magic-link", {
      form: { csrfToken, token, callbackUrl: "/", json: "true" },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    const session = (await ctx.cookies()).some((c) => /session-token/.test(c.name));
    const who = (await (await ctx.request.get("/api/auth/session")).json())?.user?.id ?? null;
    await ctx.close();
    return { status: res.status(), session, who };
  };
  const expired = await post(mintToken(userId, { nextPath: "/admin", ttlSeconds: -60 }));
  expect(expired.session).toBe(false);
  expect(expired.who).toBeNull();
  const forged = await post(mintToken(userId, { nextPath: "/admin", ttlSeconds: 600 }).split(".")[0] + ".AAAA");
  expect(forged.session).toBe(false);
  expect(forged.who).toBeNull();
  // CONTROL: the same request with a link that still works does sign in.
  const live = await post(mintToken(userId, { nextPath: "/admin", ttlSeconds: 600 }));
  expect(live.session).toBe(true);
  expect(live.who).toBe(userId);
});

for (const hostile of ["/.//evil.example", "/x/..//evil.example", "/%2e//evil.example", "/%2e%2e//evil.example/a", "//evil.example", "/\\evil.example"]) {
  test(`fix 1: /login?expired=1&callbackUrl=${hostile} and a REAL sign-in stay on this site, on the home page`, async ({ page }) => {
    const userId = await organiserId();
    await page.context().clearCookies();
    const left: string[] = [];
    page.on("request", (req) => {
      if (req.isNavigationRequest() && new URL(req.url()).origin !== new URL(E2E_BASE_URL).origin) left.push(req.url());
    });
    await page.goto(`/login?expired=1&callbackUrl=${encodeURIComponent(hostile)}`);
    await signInOnPage(page, ORGANISER_PHONE);
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    expect(onOurSite(page)).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(left).toEqual([]);
    expect(await sessionUserId(page)).toBe(userId);
  });
}

test("fix 2: an attacker's own LIVE link as the callback does not sign the victim into the attacker's account", async ({ page }) => {
  const victim = await organiserId();
  await page.context().clearCookies();
  // The attacker's link, for the attacker's account, still working.
  const attackerToken = mintToken(U.admin, { nextPath: "/admin", ttlSeconds: 600 });
  await testDb().run(`INSERT INTO "ShortLink" (code, token, "expiresAt", "createdAt") VALUES ('e2eAttack1', $1, $2::timestamp, now())`, [
    attackerToken,
    new Date(Date.now() + 600_000).toISOString(),
  ]);
  const visited: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  for (const callback of ["/r/e2eAttack1", `/r/${attackerToken}`, "/admin/../r/e2eAttack1", "/%72/e2eAttack1"]) {
    await page.context().clearCookies();
    await page.goto(`/login?expired=1&callbackUrl=${encodeURIComponent(callback)}`);
    // The genuine notice is shown: that is what makes the lure convincing.
    await expect(page.getByTestId("login-link-expired")).toBeVisible();
    await signInOnPage(page, ORGANISER_PHONE);
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    // Still the victim's own session, and the link was never opened.
    expect(await sessionUserId(page), callback).toBe(victim);
    expect(await sessionUserId(page), callback).not.toBe(U.admin);
  }
  expect(visited.filter((p) => p.startsWith("/r/"))).toEqual([]);
});

test.describe("fix 3: the expired link's club", () => {
  test.beforeAll(async () => {
    const db = testDb();
    const userId = await organiserId();
    // A second club for the organiser, joined AFTER the first: with no pin,
    // the admin pages open the older one (E2E Test FC).
    await db.run(
      `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "createdAt", "updatedAt") VALUES ($1, 'Second Club B', $1, $2, now(), now())`,
      [CLUB_B, `${CLUB_B}-invite`],
    );
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ($1, $2, $3, 'OWNER', now() + interval '1 minute')`, [
      `${CLUB_B}-membership`,
      userId,
      CLUB_B,
    ]);
  });

  test("CONTROL: with no link, the organiser of two clubs lands in the older club", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/login?callbackUrl=%2Fadmin%2Fsettings");
    await signInOnPage(page, ORGANISER_PHONE);
    await page.waitForURL("**/admin/settings", { timeout: 30_000 });
    await expect(page.getByText("E2E Test FC").first()).toBeVisible({ timeout: 30_000 });
    expect(await pinnedClub(page)).not.toBe(CLUB_B);
  });

  test("an expired link for club B: after signing in, club B's page, with club B pinned", async ({ page }) => {
    const userId = await organiserId();
    await page.context().clearCookies();
    const token = mintToken(userId, { nextPath: "/admin/settings", orgId: CLUB_B, ttlSeconds: -60 });
    await page.goto(`/r/${token}`);
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
    // The club is not in the address: it could be forged there.
    expect(page.url()).not.toContain(CLUB_B);
    await signInOnPage(page, ORGANISER_PHONE);
    await page.waitForURL("**/admin/settings", { timeout: 30_000 });
    expect(await pinnedClub(page)).toBe(CLUB_B);
    await expect(page.locator("#org-name")).toHaveValue("Second Club B", { timeout: 30_000 });
    const api = await (await page.request.get("/api/org/settings")).json();
    expect(api.id).toBe(CLUB_B);
  });

  test("somebody ELSE signing in with that expired link gets their own default page: no pin, no page, no word of why", async ({ page }) => {
    const organiser = await organiserId();
    await page.context().clearCookies();
    const token = mintToken(organiser, { nextPath: "/admin/settings", orgId: CLUB_B, ttlSeconds: -60 });
    await page.goto(`/login?expired=1&link=${encodeURIComponent(token)}`);
    // The seeded club's own admin signs in with the organiser's old link.
    await signInOnPage(page, PHONE.admin);
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    expect(await sessionUserId(page)).toBe(U.admin);
    expect(await pinnedClub(page)).not.toBe(CLUB_B);
    await expect(page.locator("body")).not.toContainText("Second Club B");
    const api = await (await page.request.get("/api/org/settings")).json();
    expect(api.id).toBe(ORG_ID);
  });

  test("a forged or tampered link is ignored: the default page and no pin", async ({ page }) => {
    const organiser = await organiserId();
    const good = mintToken(organiser, { nextPath: "/admin/settings", orgId: CLUB_B, ttlSeconds: -60 });
    const [body, sig] = good.split(".");
    // A payload changed to another club, under the old signature; and a made-up signature.
    const swapped = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), nextPath: "/admin/players" }),
    ).toString("base64url");
    for (const link of [`${swapped}.${sig}`, `${body}.AAAA`, "neverACode", "not a link at all/../x"]) {
      await page.context().clearCookies();
      await page.goto(`/login?expired=1&link=${encodeURIComponent(link)}`);
      await signInOnPage(page, ORGANISER_PHONE);
      await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
      expect(await pinnedClub(page), link).not.toBe(CLUB_B);
      expect(await sessionUserId(page), link).toBe(organiser);
    }
  });

  test("a link that still WORKS is not accepted as 'expired' at sign-in either", async ({ page }) => {
    const organiser = await organiserId();
    await page.context().clearCookies();
    const liveToken = mintToken(organiser, { nextPath: "/admin/settings", orgId: CLUB_B, ttlSeconds: 600 });
    await page.goto(`/login?expired=1&link=${encodeURIComponent(liveToken)}`);
    await signInOnPage(page, ORGANISER_PHONE);
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    expect(await pinnedClub(page)).not.toBe(CLUB_B);
  });
});
