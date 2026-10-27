/**
 * The landing page's newer sections (website update G0, part 1): partner
 * clubs, the admin group for organisers, and the settings that fit how a
 * group already plays. A signed-out visitor reads each one at phone and
 * desktop width with no sideways scroll; the nav and footer links work;
 * the page reads as plain words (no em or en dashes, no real club names,
 * "bench" never "waiting list"). No model calls: $0.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { LANDING_SPOTLIGHTS } from "@/components/landing/landing-content";
import { poolPageCopy } from "@/lib/pool/page-copy";

const MOBILE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
  test(`every spotlight section reads on ${name} width with no sideways scroll`, async ({ page }) => {
    await page.setViewportSize(size);
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    for (const s of LANDING_SPOTLIGHTS) {
      const section = page.locator(`section#${s.id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByRole("heading", { level: 2, name: s.title })).toBeVisible();
      // The section is named by its heading, for screen readers.
      await expect(page.getByRole("region", { name: s.title })).toHaveCount(1);
      await expect(section.getByText(s.lead)).toBeVisible();
      for (const step of s.steps ?? []) {
        await expect(section.getByRole("heading", { level: 3, name: step.title })).toBeVisible();
      }
      for (const p of s.points) {
        await expect(section.getByRole("heading", { level: 3, name: p.title })).toBeVisible();
      }
      for (const item of s.note?.items ?? []) {
        await expect(section.getByText(item.text)).toBeVisible();
      }
      if (s.chat) await expect(section.getByRole("figure", { name: s.chat.caption })).toBeVisible();
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/landing-${name}.png`, fullPage: true });
  });
}

test("the short-of-players section names who is asked, in order, and keeps numbers private", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("section#short-of-players");
  await section.scrollIntoViewIfNeeded();
  const steps = section.getByRole("list", { name: /who matchtime asks, in order/i }).getByRole("listitem");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(1)).toContainText("partner clubs");
  await expect(steps.nth(2)).toContainText("player pool");
  await expect(section.getByText(/Phone numbers are never shared between clubs/)).toBeVisible();
  await expect(section.getByText(/Your number is not shared with Riverside FC/)).toBeVisible();
});

test("the desktop For clubs menu jumps to the short-of-players and admin group sections", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("button", { name: "For clubs" }).click();
  await nav.getByRole("link", { name: "Short of players", exact: true }).click();
  await expect(page).toHaveURL(/#short-of-players$/);
  await expect(page.locator("section#short-of-players").getByRole("heading", { level: 2 })).toBeInViewport();
  await nav.getByRole("button", { name: "For clubs" }).click();
  await nav.getByRole("link", { name: "Admin group", exact: true }).click();
  await expect(page).toHaveURL(/#admin-group$/);
  await expect(page.locator("section#admin-group").getByRole("heading", { level: 2 })).toBeInViewport();
});

test("every page link on the landing page answers 200, and the footer keeps the privacy link", async ({ page, request }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer.getByRole("link", { name: /privacy/i })).toHaveAttribute("href", "/privacy");
  const hrefs = await page.locator('a[href^="/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href")!))]);
  expect(hrefs).toEqual(expect.arrayContaining(["/signup", "/login", "/help/player", "/help/admin", "/privacy"]));
  for (const href of hrefs) {
    const res = await request.get(href);
    expect(res.status(), href).toBe(200);
  }
  await footer.getByRole("link", { name: /privacy/i }).click();
  await page.waitForURL("**/privacy");
});

test("the whole page reads as plain words: no dashes, no real club names, bench not waiting list", async ({ page }) => {
  await page.goto("/");
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/[—–]/);
  expect(body).not.toMatch(/\bFNF\b|Sutton|Hamzah|Erdal/);
  expect(body).not.toMatch(/waiting list/i);
});

test.describe("the player pool invitation (G0 part 2)", () => {
  test("the pool section's pulsing button leads to /play, and the For players menu has the pool", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "For players" }).click();
    await nav.getByRole("link", { name: "Player pool", exact: true }).click();
    await expect(page).toHaveURL(/#player-pool$/);
    const cta = page.locator("section#player-pool").getByTestId("spotlight-cta");
    await expect(cta).toHaveAttribute("href", "/play");
    await expect(cta).toHaveText("Join the MatchTime player pool");
    await cta.click();
    await page.waitForURL("**/play");
    await expect(page.getByRole("heading", { level: 1, name: poolPageCopy("en").signup.heading })).toBeVisible();
  });

  test("the button pulses under 3 times a second", async ({ page }) => {
    await page.goto("/");
    const cta = page.locator("section#player-pool").getByTestId("spotlight-cta");
    const anim = await cta.evaluate((el) => {
      const s = getComputedStyle(el);
      return { name: s.animationName, duration: s.animationDuration };
    });
    expect(anim.name).toBe("pool-invite-pulse");
    const seconds = parseFloat(anim.duration) / (anim.duration.endsWith("ms") ? 1000 : 1);
    expect(1 / seconds).toBeLessThan(3);
  });

  test.describe("for a visitor who asked for less motion", () => {
    test("the button does not pulse", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      const cta = page.locator("section#player-pool").getByTestId("spotlight-cta");
      expect(await cta.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    });
  });
});
