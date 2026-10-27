/**
 * The website for its two audiences (Kemal, 2026-10-25: "where is the
 * flashy button?" and "we need separate menu for players and for clubs").
 *
 *   - The hero invites PLAYERS to the pool (round two, 2026-10-26: a players
 *     card above the feature deck, to /play); the organisers' "Start your group"
 *     stays the first action; no payments or pricing line in the hero.
 *   - The menu has a "For clubs" and a "For players" group, as dropdowns on
 *     desktop and two labelled sections in the phone menu; every link in it
 *     opens a page that answers 200 or an anchor that exists.
 *   - /players is written for players: the benefit and the pulsing button
 *     first, how it works, what is shared, the questions.
 *
 * No model calls: $0. Screenshots go to MT_SCREENSHOT_DIR when it is set.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import path from "node:path";
import { E2E_BASE_URL } from "../helpers/env";
import { poolPageCopy } from "@/lib/pool/page-copy";
import {
  HERO_POOL_INVITE,
  LANDING_NAV_GROUPS,
  PLAYERS_FAQ,
  PLAYERS_PAGE,
  allNavLinks,
} from "@/components/landing/landing-content";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const SHOTS = process.env.MT_SCREENSHOT_DIR;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
}

/** Open a page signed out, and wait until the session check is over: while
 *  it runs the app shell still shows its signed-in bar. */
async function open(page: Page, url: string) {
  const res = await page.goto(url);
  await expect(page.getByRole("button", { name: "Toggle menu" })).toHaveCount(0);
  return res;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const [name, size, file] of [
  ["phone", PHONE, "hero-390.png"],
  ["desktop", DESKTOP, "hero-1280.png"],
] as const) {
  test(`the hero invites players to the pool on ${name} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, "/");
    // Round two (2026-10-26): the players' card in the hero, above the deck.
    const hero = page.locator("#hero");
    const join = hero.getByTestId("hero-players-card").getByRole("link", { name: HERO_POOL_INVITE.cta.label });
    await expect(join).toHaveAttribute("href", HERO_POOL_INVITE.cta.href);

    // The organisers' button stays the first action, before the players' link.
    const start = hero.getByRole("link", { name: "Start your group" });
    await expect(start).toBeInViewport();
    const [startBox, joinBox] = [await start.boundingBox(), await join.boundingBox()];
    expect(startBox!.y).toBeLessThan(joinBox!.y);

    // Payments' pricing is on the pricing page, never in the hero.
    await expect(hero.getByText(/card or bank|months free|weeks you play/i)).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, file);
  });
}

test("the hero's pool link takes a player to the /play sign-up", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, "/");
  await page.locator("#hero").getByTestId("hero-pool-join").click();
  await page.waitForURL(/\/play\?src=/);
  await expect(page.getByRole("heading", { level: 1, name: "Join the MatchTime player pool" })).toBeVisible();
});

test("desktop menu: a For clubs and a For players dropdown, each with its links and button", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, "/");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const g of LANDING_NAV_GROUPS) {
    const trigger = nav.getByRole("button", { name: g.label });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = nav.getByRole("group", { name: g.label });
    for (const l of [...g.links, g.cta]) {
      await expect(panel.getByRole("link", { name: l.label, exact: true })).toHaveAttribute("href", l.href.replace(/^\/#/, "#"));
    }
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("phone menu: two labelled sections, For clubs and For players", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, "/");
  // The desktop dropdowns are not shown at phone width.
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "Menu" });
  await expect(menu).toBeVisible();
  for (const g of LANDING_NAV_GROUPS) {
    const section = menu.getByRole("group", { name: g.label });
    await expect(section).toBeVisible();
    for (const l of [...g.links, g.cta]) {
      await expect(section.getByRole("link", { name: l.label, exact: true })).toBeVisible();
    }
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "menu-390.png");
  // Tapping an anchor closes the menu and lands on the section.
  await menu.getByRole("group", { name: "For clubs" }).getByRole("link", { name: "Short of players", exact: true }).click();
  await expect(page).toHaveURL(/#short-of-players$/);
  await expect(menu).toBeHidden();
});

test("every menu link resolves: pages answer 200 and anchors exist on the home page", async ({ page, request }) => {
  await open(page, "/");
  for (const l of allNavLinks()) {
    const [pathname, hash] = l.href.split("#");
    if (hash !== undefined) {
      expect(pathname, l.href).toBe("/");
      await expect(page.locator(`[id="${hash}"]`), l.href).toHaveCount(1);
    } else {
      expect((await request.get(l.href)).status(), l.href).toBe(200);
    }
  }
});

for (const [name, size, file] of [
  ["phone", PHONE, "players-390.png"],
  ["desktop", DESKTOP, "players-1280.png"],
] as const) {
  test(`/players is for players on ${name} width: the benefit and the pulsing button first`, async ({ page }) => {
    await page.setViewportSize(size);
    const res = await open(page, "/players");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: PLAYERS_PAGE.title })).toBeVisible();
    const join = page.getByTestId("players-join");
    await expect(join).toHaveText(PLAYERS_PAGE.cta.label);
    await expect(join).toHaveAttribute("href", PLAYERS_PAGE.cta.href);
    await expect(join).toBeInViewport({ ratio: 1 });
    expect(await join.evaluate((el) => getComputedStyle(el).animationName)).toBe("pool-invite-pulse");
    // The menu is there too, with both groups.
    if (name === "desktop") {
      for (const g of LANDING_NAV_GROUPS) await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: g.label })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, file);
  });
}

test("/players explains how it works, what is shared, and answers the questions", async ({ page }) => {
  await open(page, "/players");
  for (const s of PLAYERS_PAGE.steps) await expect(page.getByRole("heading", { level: 3, name: s.title })).toBeVisible();
  for (const p of PLAYERS_PAGE.points) await expect(page.getByRole("heading", { level: 3, name: p.title })).toBeVisible();
  for (const i of PLAYERS_PAGE.note.items) await expect(page.getByText(i.text)).toBeVisible();
  for (const q of PLAYERS_FAQ) {
    const item = page.getByRole("group").filter({ hasText: q.question });
    await item.getByText(q.question).click();
    await expect(item.getByText(q.answer)).toBeVisible();
  }
  await expect(page.getByRole("link", { name: PLAYERS_PAGE.privacyLink })).toHaveAttribute("href", "/privacy");
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/[—–]/);
  expect(body).not.toMatch(/waiting list/i);
  // The closing button goes to the sign-up too, and does not pulse.
  const closing = page.getByTestId("players-join-closing");
  await expect(closing).toHaveAttribute("href", PLAYERS_PAGE.closingCta.href);
  expect(await closing.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.getByTestId("players-join").click();
  await page.waitForURL(/\/play\?src=/);
});

/**
 * The early sign-up list is mentioned only while a sign-up really goes on
 * it: the pages read the same switch as the sign-up route
 * (signupGoesOnEarlyList, with the MT_TEST_MODE cookie seam).
 */
for (const open of [false, true]) {
  test(`the early-list line follows the server's switch (pool ${open ? "open" : "not open"}): home, /players and /play`, async ({ page }) => {
    await page.context().addCookies([{ name: "mt-test-pool-open", value: open ? "1" : "0", url: E2E_BASE_URL }]);
    const en = poolPageCopy("en").signup;
    const [shown, hidden] = open ? [en.openNote, en.earlyNote] : [en.earlyNote, en.openNote];
    for (const url of ["/", "/players", "/play"]) {
      await page.goto(url);
      const body = page.locator("body");
      await expect(body.getByText(shown).first(), url).toBeVisible();
      await expect(body.getByText(hidden), url).toHaveCount(0);
      if (open) await expect(body.getByText(/early sign-up list/i), url).toHaveCount(0);
    }
  });
}

/** The pricing page (Kemal, 2026-10-25): its own page, the free period first. */
for (const [name, size, file] of [
  ["phone", PHONE, "pricing-390.png"],
  ["desktop", DESKTOP, "pricing-1280.png"],
] as const) {
  test(`/pricing on ${name} width: the free months are bigger than the price`, async ({ page }) => {
    await page.setViewportSize(size);
    const res = await open(page, "/pricing");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Try it with your group first." })).toBeVisible();
    const lead = page.locator("section#pricing").getByTestId("price-lead");
    const amount = page.locator("section#pricing").getByTestId("price-amount");
    await expect(lead).toHaveText(/^First \w+ months? free$/);
    await expect(amount).toContainText("up to £9.99 a month");
    const px = (l: typeof lead) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(await px(lead)).toBeGreaterThan((await px(amount)) * 1.5);
    await expect(page.getByText(/about 50p a player/)).toBeVisible();
    await expect(page.getByText("No contract. Stop any time")).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await lead.scrollIntoViewIfNeeded();
    await shot(page, file);
  });
}

test("the For clubs menu's Pricing link opens /pricing, and the home teaser links there too", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, "/");
  const teaser = page.locator("section#pricing");
  await expect(teaser.getByTestId("price-lead")).toBeVisible();
  await expect(teaser.getByRole("link", { name: "See pricing" })).toHaveAttribute("href", "/pricing");
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("button", { name: "For clubs" }).click();
  await nav.getByRole("link", { name: "Pricing", exact: true }).click();
  await page.waitForURL("**/pricing");
  await expect(page.getByRole("heading", { level: 1, name: "Try it with your group first." })).toBeVisible();
});

// Kemal, 2026-10-25: the weekly cap on game offers still applies, but the
// site no longer states it. The /play consent tickbox still does.
test("home, /players and /pricing say nothing about how many game offers a week", async ({ page }) => {
  for (const url of ["/", "/players", "/pricing"]) {
    await open(page, url);
    await expect(page.locator("body")).not.toContainText(/offers a week/i);
  }
});
