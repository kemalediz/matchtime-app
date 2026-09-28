/**
 * Public marketing site: the landing page and the help guides must be
 * readable by a signed-out visitor (Kemal's ad points people at them),
 * without the empty app sidebar, and must still work for signed-in users.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";

test.beforeAll(async () => {
  resetDb();
});

const GUIDES: Array<[string, RegExp]> = [
  ["/help", /What MatchTime does, in one minute/i],
  ["/help/player", /The one rule: tag it for anything but In or Out/i],
  ["/help/admin", /What happens each week/i],
];

for (const [path, heading] of GUIDES) {
  test(`signed-out visitor can read ${path}`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText(heading).first()).toBeVisible();
    // No app sidebar (Dashboard / Matches / Profile) for a visitor.
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: /^matches$/i })).toHaveCount(0);
  });
}

test("landing page says it is free and links the player guide", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Free to use/i).first()).toBeVisible();
  await page.getByRole("link", { name: /read the player guide/i }).click();
  await page.waitForURL("**/help/player");
  await expect(page.getByText(/The one rule/i)).toBeVisible();
});

test("robots.txt is served and points at the sitemap", async ({ request }) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/Sitemap: .*\/sitemap\.xml/);
  expect(body).toMatch(/Disallow: \/admin/);
});

test("signed-in admin still gets the guides", async ({ page }) => {
  await signInAs(page, U.admin);
  await page.goto("/help/admin");
  await expect(page).toHaveURL(/\/help\/admin$/);
  await expect(page.getByText(/What happens each week/i)).toBeVisible();
  // Signed-in users keep the app sidebar on the guides.
  await expect(page.getByRole("link", { name: /^matches$/i }).first()).toBeVisible();
});

test("app pages still require sign-in", async ({ page }) => {
  await page.goto("/admin/players");
  await page.waitForURL("**/login**", { timeout: 30_000 });
});
