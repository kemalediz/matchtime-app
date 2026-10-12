/**
 * Magic-link sign-in flow (/r/[token]).
 *   - valid token → real NextAuth session + redirect to the intended path
 *   - expired token → the sign-in page with "that link has expired", no
 *     session (2026-10: it used to be a dead-end error card)
 *   - garbage token → clear error state + "Go to sign in" escape hatch
 */
import { test, expect, mintToken, signInAs, resetDb, U } from "../fixtures";


test.beforeAll(async () => {
  resetDb();
});

test("valid magic link signs the player in and forwards to nextPath", async ({ page }) => {
  const token = mintToken(U.player, { nextPath: "/profile/stats" });
  await page.goto(`/r/${token}`);
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  // Session is real — a protected page renders for THIS user.
  await expect(page.getByText("Pat", { exact: false }).first()).toBeVisible();
});

test("expired token goes to sign-in with a notice and does not sign in", async ({ page }) => {
  const token = mintToken(U.player, { ttlSeconds: -60 });
  await page.goto(`/r/${token}`);
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
  await expect(page.getByTestId("login-link-expired")).toHaveText(
    "That link has expired. Sign in with your WhatsApp number to carry on.",
  );
  await expect(page.getByRole("button", { name: "Sign in with WhatsApp" })).toBeVisible();
  // No session: a protected page bounces to /login.
  await page.goto("/profile/stats");
  await page.waitForURL("**/login**", { timeout: 30_000 });
});

test("garbage token shows the error state", async ({ page }) => {
  await page.goto("/r/this-is-not-a-real-token");
  await expect(page.getByText("This link isn't valid.")).toBeVisible();
  await expect(page.getByRole("link", { name: /go to sign in/i })).toBeVisible();
});

test("signed-in session persists across navigation", async ({ page }) => {
  await signInAs(page, U.admin);
  await page.goto("/admin/players");
  await expect(page).toHaveURL(/\/admin\/players/);
  await expect(page.getByText("E2E Test FC")).toBeVisible();
});
