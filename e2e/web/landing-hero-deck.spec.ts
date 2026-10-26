/**
 * The home page's hero, variant E (2026-10-26): the headline, the two
 * buttons, one tick, then a sliding deck of eight feature cards. Prev and
 * next buttons and dots move the deck on every size; a card opens its
 * detail: a bottom sheet on a phone (a dialog, closed by its button or
 * Escape), a panel under the deck on desktop. No pricing in the hero, and
 * no sideways scroll at 390 wide. No model calls: $0.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import path from "node:path";
import { HERO, HERO_DECK } from "@/components/landing/landing-content";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const SHOTS = process.env.MT_SCREENSHOT_DIR;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
}

async function open(page: Page) {
  await page.goto("/");
  // While the session check runs the app shell still shows its signed-in
  // bar (phone) or sidebar (desktop); wait until both are gone.
  await expect(page.getByRole("button", { name: "Toggle menu" })).toHaveCount(0);
  await expect(page.locator("aside")).toHaveCount(0);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const deckOf = (page: Page) => page.getByRole("region", { name: HERO_DECK.sectionLabel });
const cardButton = (page: Page, title: string) => deckOf(page).getByRole("button", { name: new RegExp(`^${title.replace(/[?]/g, "\\?")}`) });

for (const [name, size] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`the hero and its eight cards render on ${name} width, with no pricing and no sideways scroll`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page);
    await expect(page.locator("#hero").getByRole("heading", { level: 1 })).toHaveText(`${HERO.titleLead}${HERO.titleTail}`);
    await expect(page.getByText(HERO.line)).toBeVisible();
    await expect(page.getByRole("link", { name: HERO.secondary.label })).toHaveAttribute("href", HERO.secondary.href);
    const deck = deckOf(page);
    await expect(deck).toBeVisible();
    for (const c of HERO_DECK.cards) await expect(cardButton(page, c.title)).toHaveCount(1);
    await expect(deck.getByRole("button", { name: HERO_DECK.dotLabel(1) })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("link", { name: HERO_DECK.poolLink.label })).toHaveAttribute("href", HERO_DECK.poolLink.href);

    const hero = page.locator("#hero");
    await expect(hero.getByText(/months free|first two months|weeks you play|£9|a month/i)).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await shot(page, `hero-e-${name}.png`);
  });

  test(`the next button moves the deck on ${name} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page);
    const deck = deckOf(page);
    const prev = deck.getByRole("button", { name: HERO_DECK.prevLabel });
    await expect(prev).toBeDisabled();
    await deck.getByRole("button", { name: HERO_DECK.nextLabel }).click();
    await expect(deck.getByRole("button", { name: HERO_DECK.dotLabel(2) })).toHaveAttribute("aria-current", "true");
    await expect(prev).toBeEnabled();
    const track = deck.getByTestId("deck-track");
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    // A dot jumps straight to its card.
    await deck.getByRole("button", { name: HERO_DECK.dotLabel(8) }).click();
    await expect(deck.getByRole("button", { name: HERO_DECK.dotLabel(8) })).toHaveAttribute("aria-current", "true");
    await expect(deck.getByRole("button", { name: HERO_DECK.nextLabel })).toBeDisabled();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("phone: a card opens its bottom sheet; the close button and Escape close it", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  const card = HERO_DECK.cards[0];
  const button = cardButton(page, card.title);
  await button.click();
  const sheet = page.getByRole("dialog", { name: card.title });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  for (const d of card.details) await expect(sheet.getByText(d)).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  // Focus moves into the sheet.
  await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  // The sheet sits at the bottom of the screen.
  const box = (await sheet.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(PHONE.height - 2);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "hero-e-phone-open.png");

  await sheet.getByRole("button", { name: HERO_DECK.closeLabel, exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(button).toBeFocused();

  // Another card, closed with Escape.
  const pool = HERO_DECK.cards.find((c) => c.key === "short")!;
  await cardButton(page, pool.title).click();
  const poolSheet = page.getByRole("dialog", { name: pool.title });
  await expect(poolSheet).toBeVisible();
  await expect(poolSheet.getByRole("list", { name: "Who is asked, in order" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(poolSheet).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("desktop: a card opens its panel under the deck, one at a time; close and Escape close it", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page);
  const [first, second] = HERO_DECK.cards;
  await cardButton(page, first.title).click();
  const panel = page.getByRole("region", { name: HERO_DECK.detailsLabel });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { level: 3, name: first.title })).toBeVisible();
  for (const d of first.details) await expect(panel.getByText(d)).toBeVisible();
  // Under the deck, not a modal.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const deckBox = (await deckOf(page).getByTestId("deck-track").boundingBox())!;
  expect((await panel.boundingBox())!.y).toBeGreaterThan(deckBox.y + deckBox.height - 1);
  if (SHOTS) {
    await page.waitForTimeout(800); // let the smooth scroll settle
    await panel.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot(page, "hero-e-desktop-open.png");
  }

  // Only one open at a time.
  await cardButton(page, second.title).click();
  await expect(panel.getByRole("heading", { level: 3, name: second.title })).toBeVisible();
  await expect(panel.getByRole("heading", { level: 3, name: first.title })).toHaveCount(0);
  await expect(cardButton(page, first.title)).toHaveAttribute("aria-expanded", "false");

  await panel.getByRole("button", { name: HERO_DECK.closeLabel, exact: true }).click();
  await expect(panel).toBeHidden();

  await cardButton(page, first.title).click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("the deck works from the keyboard", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await open(page);
  const deck = deckOf(page);
  const next = deck.getByRole("button", { name: HERO_DECK.nextLabel });
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(deck.getByRole("button", { name: HERO_DECK.dotLabel(2) })).toHaveAttribute("aria-current", "true");
  const card = cardButton(page, HERO_DECK.cards[1].title);
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: HERO_DECK.detailsLabel }).getByRole("heading", { level: 3, name: HERO_DECK.cards[1].title })).toBeVisible();
});
