/**
 * Public marketing site: the landing page and the help guides must be
 * readable by a signed-out visitor (Kemal's ad points people at them),
 * without the empty app sidebar, and must still work for signed-in users.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { firstMonthsFree, firstMonthsFreeBadge } from "@/lib/i18n/free-period";

/** The only "free" a visitor may read: the free period, in the words the
 *  pages build from FREE_PERIOD_MONTHS (two months since 2026-10-12). */
const FIRST_FREE = firstMonthsFree("en");
const FIRST_FREE_BADGE = firstMonthsFreeBadge();
const withoutFreePeriod = (text: string) =>
  text.replaceAll(FIRST_FREE, "").replaceAll(FIRST_FREE_BADGE, "").replace(/\bfree period\b/gi, "");

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

test("landing page shows the price and links the player guide", async ({ page }) => {
  await page.goto("/");
  expect(FIRST_FREE).toBe("Your first two months are free");
  await expect(page.getByText("First two months free", { exact: true }).first()).toBeVisible();
  // Pricing section: up to £9.99 a month per group, first two months free (Kemal, 2026-10-12).
  const pricing = page.locator("#pricing");
  await pricing.scrollIntoViewIfNeeded();
  await expect(pricing.getByRole("heading", { name: /One price for the whole group/i })).toBeVisible();
  await expect(pricing.getByText("£9.99", { exact: true })).toBeVisible();
  await expect(pricing.getByText(/a month per group/i)).toBeVisible();
  await expect(pricing.getByText(/about 50p a player/i)).toBeVisible();
  // Charged by games played, up to £9.99 a month (Kemal, 2026-10-02).
  await expect(pricing.getByText(/Up to £9\.99 a month per WhatsApp group, not per player, and you only pay for the weeks you play/)).toBeVisible();
  await expect(pricing.getByText(/Your first two months are free, so you can see how it runs your week before you pay\./)).toBeVisible();
  await expect(page.getByText(/Your first two months are free, and you can remove it from your group any time\./)).toBeVisible();
  await expect(page.getByText(/Your first two months are free, then it's up to £9\.99 a month for the whole group/)).toBeVisible();
  await expect(pricing.getByText(/Play 3 weeks out of 4 and it's £7\.49\. Take a month off and it's nothing\./)).toBeVisible();
  // Nothing on the page still claims MatchTime is free.
  const body = withoutFreePeriod(await page.locator("body").innerText());
  expect(body).not.toMatch(/\bfree\b/i);
  expect(body).not.toMatch(/first month/i);
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

test("the organiser guide explains the club fee: games played, up to £9.99, the card, stopping", async ({ page }) => {
  await page.goto("/help/admin");
  const heading = page.getByRole("heading", { name: "Club fee", exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  const guide = page.locator("article");
  await expect(guide.getByText(/only pay for the weeks you play: up to £9\.99 a month per WhatsApp group, VAT included/)).toBeVisible();
  await expect(guide.getByText(/adds a card/).first()).toBeVisible();
  await expect(guide.getByText(/at most about 25p a player per game/)).toBeVisible();
  await expect(guide.getByText(/Your first two months are free, counted from the day we approve your club\./)).toBeVisible();
  await expect(guide.getByText(/Nine days before your free period ends/)).toBeVisible();
  const text = withoutFreePeriod(await guide.innerText());
  expect(text).not.toMatch(/\bfree\b/i);
  expect(text).not.toMatch(/first month/i);
  expect(text).not.toMatch(/[—–]/);
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
