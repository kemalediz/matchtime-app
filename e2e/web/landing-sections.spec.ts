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
import { LANDING_NAV, LANDING_SPOTLIGHTS } from "@/components/landing/landing-content";

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

test("the partner clubs section explains an ask step by step and keeps numbers private", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("section#partner-clubs");
  await section.scrollIntoViewIfNeeded();
  const steps = section.getByRole("list", { name: /how an ask works/i }).getByRole("listitem");
  await expect(steps).toHaveCount(4);
  await expect(section.getByText(/Phone numbers are never shared between clubs/)).toBeVisible();
  await expect(section.getByText(/Your number is not shared with Riverside FC/)).toBeVisible();
});

test("desktop nav jumps to the partner clubs and admin group sections", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const n of LANDING_NAV.filter((x) => x.href.startsWith("#"))) {
    await expect(nav.getByRole("link", { name: n.label, exact: true })).toHaveAttribute("href", n.href);
  }
  await nav.getByRole("link", { name: "Partner clubs", exact: true }).click();
  await expect(page).toHaveURL(/#partner-clubs$/);
  await expect(page.locator("section#partner-clubs").getByRole("heading", { level: 2 })).toBeInViewport();
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
