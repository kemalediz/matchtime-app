/**
 * The home page for players (variant D round 2): a "New" players card in
 * the hero, whole on the first screen at 390 and 1440 wide, whose button
 * goes to /play?src=site-hero; the key features row right after the
 * dropout story; then the player pool section, "Get called up for local
 * games.", with the drawn WhatsApp offer in the bot's own words, the four
 * steps and the facts. The headline's full stops sit against their word.
 * No model calls: $0.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { DROPOUT_STORY, HERO_POOL_INVITE, KEY_FEATURES, LANDING_SPOTLIGHTS, POOL_SECTION, POOL_SITE_SOURCES } from "@/components/landing/landing-content";
import { poolOfferMock } from "@/components/landing/pool-offer-lines";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const POOL = LANDING_SPOTLIGHTS.find((s) => s.id === "player-pool")!;
const plain = (s: string) => s.replace(/\*/g, "");

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const [name, size] of [["390", PHONE], ["1440", DESKTOP]] as const) {
  test(`the players card is on the first screen at ${name} wide, and its button goes to /play?src=site-hero`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    const card = page.getByTestId("hero-players-card");
    await expect(card).toBeInViewport({ ratio: 1 });
    await expect(card.getByText(HERO_POOL_INVITE.badge, { exact: true })).toBeVisible();
    await expect(card.getByRole("heading", { level: 2, name: HERO_POOL_INVITE.title })).toBeVisible();
    await expect(card.getByText(HERO_POOL_INVITE.body)).toBeVisible();
    await expect(card.getByText(HERO_POOL_INVITE.smallPrint)).toBeVisible();
    const join = card.getByRole("link", { name: HERO_POOL_INVITE.cta.label });
    await expect(join).toHaveAttribute("href", `/play?src=${POOL_SITE_SOURCES.hero}`);
    expect((await join.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // It sits under the club buttons.
    const start = page.locator("section").first().getByRole("link", { name: "Start your group" });
    expect((await start.boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);
    await expect(card).not.toContainText(/£|free|a month|price|a week/i);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test(`the story, then the key features, then the player pool, at ${name} wide`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    const ids = await page.locator("body section").evaluateAll((els) => els.map((e) => e.id));
    expect(ids.slice(1, 4)).toEqual([DROPOUT_STORY.id, KEY_FEATURES.id, "player-pool"]);

    const row = page.getByRole("region", { name: KEY_FEATURES.title });
    for (const c of KEY_FEATURES.cards) {
      await expect(row.getByRole("heading", { level: 3, name: c.title })).toBeVisible();
      await expect(row.getByText(c.body)).toBeVisible();
    }

    const pool = page.getByRole("region", { name: POOL.title });
    await pool.scrollIntoViewIfNeeded();
    await expect(pool.getByText(POOL.badge!, { exact: true })).toBeVisible();
    await expect(pool.getByText(POOL_SECTION.benefit)).toBeVisible();
    const offer = pool.getByRole("figure", { name: POOL_SECTION.offer.caption });
    await expect(offer).toBeVisible();
    const m = poolOfferMock();
    for (const l of [...m.offer, m.cta, m.placed]) await expect(offer).toContainText(plain(l));
    for (const s of POOL.steps!) await expect(pool.getByRole("heading", { level: 3, name: s.title })).toBeVisible();
    for (const i of POOL.note!.items) await expect(pool.getByText(i.text)).toBeVisible();
    await expect(pool).not.toContainText(/£|rating|a week|waiting list/i);
    expect(await pool.innerText()).not.toMatch(/[—–]/);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("the desktop headline's full stops sit against their word", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const gaps = await page.locator("section").first().locator("h1 > span.block").evaluateAll((lines) =>
    lines.map((line) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
      const word = texts[0];
      const stop = texts[texts.length - 1];
      const r1 = document.createRange();
      r1.setStart(word, word.data.length - 1);
      r1.setEnd(word, word.data.length);
      const r2 = document.createRange();
      r2.setStart(stop, stop.data.length - 1);
      r2.setEnd(stop, stop.data.length);
      // How far the stop's box starts past the last letter's box, as a share of the font size.
      const size = parseFloat(getComputedStyle(line).fontSize);
      return (r2.getBoundingClientRect().left - r1.getBoundingClientRect().right) / size;
    }),
  );
  expect(gaps).toHaveLength(2);
  for (const g of gaps) expect(g).toBeLessThan(-0.05);
  await expect(page.locator("section").first().locator("h1")).toHaveText("Your players WhatsApp. MatchTime runs the game.");
});
