/**
 * The home page's hero, variant E (2026-10-26; round three 2026-10-27): the
 * headline, the two buttons, then a sliding deck of nine feature cards. Prev and
 * next buttons and dots move the deck on every size; a card opens its
 * detail: a bottom sheet on a phone (a dialog, closed by its button or
 * Escape), a panel under the deck on desktop. No pricing in the hero, and
 * no sideways scroll at 390 wide. No model calls: $0.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import path from "node:path";
import { HERO, HERO_DECK, HERO_POOL_INVITE, LANDING_SPOTLIGHTS } from "@/components/landing/landing-content";

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
  test(`the hero and its nine cards render on ${name} width, with no pricing and no sideways scroll`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page);
    await expect(page.locator("#hero").getByRole("heading", { level: 1 })).toHaveText(`${HERO.titleLead}${HERO.titleTail}`);
    await expect(page.getByText(HERO.line)).toBeVisible();
    await expect(page.getByRole("link", { name: HERO.secondary.label })).toHaveAttribute("href", HERO.secondary.href);
    const deck = deckOf(page);
    await expect(deck).toBeVisible();
    for (const c of HERO_DECK.cards) await expect(cardButton(page, c.title)).toHaveCount(1);
    await expect(deck.getByRole("button", { name: HERO_DECK.dotLabel(1) })).toHaveAttribute("aria-current", "true");

    const hero = page.locator("#hero");
    // Round three: the "No app for players" tick row is gone.
    await expect(hero.getByRole("list", { name: "Good to know" })).toHaveCount(0);
    await expect(hero.getByText("No app for players")).toHaveCount(0);
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
    const last = HERO_DECK.cards.length;
    expect(last).toBe(9);
    await deck.getByRole("button", { name: HERO_DECK.dotLabel(last) }).click();
    await expect(deck.getByRole("button", { name: HERO_DECK.dotLabel(last) })).toHaveAttribute("aria-current", "true");
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
  // The chain is drawn first, the pool highlighted, then the real offer.
  await expect(poolSheet.getByRole("figure", { name: /Private message to a player in the pool/ })).toBeAttached();
  // The sheet scrolls inside itself, and its close button stays on screen.
  const scroller = poolSheet;
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  await expect(poolSheet.getByRole("button", { name: HERO_DECK.closeLabel, exact: true })).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(poolSheet).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("phone: the next card peeks in, and each card carries a See how cue", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  const second = cardButton(page, HERO_DECK.cards[1].title);
  const box = (await second.boundingBox())!;
  // Partly on screen: it starts before the right edge and runs past it.
  expect(box.x).toBeLessThan(PHONE.width - 40);
  expect(box.x + box.width).toBeGreaterThan(PHONE.width);
  await expect(cardButton(page, HERO_DECK.cards[0].title).getByText(HERO_DECK.seeHow)).toBeVisible();
  // The arrows sit by the title, visible without scrolling the deck.
  const deck = deckOf(page);
  await deck.scrollIntoViewIfNeeded();
  for (const l of [HERO_DECK.prevLabel, HERO_DECK.nextLabel]) {
    const b = (await deck.getByRole("button", { name: l }).boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
});

for (const [name, size] of [["390", { width: 390, height: 844 }], ["1440", { width: 1440, height: 900 }]] as const) {
  test(`the players card is on the first screen at ${name} wide, and its button goes to /play?src=site-hero`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page);
    const card = page.locator("#hero").getByTestId("hero-players-card");
    await expect(card).toBeInViewport({ ratio: 1 });
    await expect(card.getByText(HERO_POOL_INVITE.badge, { exact: true })).toBeVisible();
    await expect(card.getByRole("heading", { name: HERO_POOL_INVITE.title })).toBeVisible();
    await expect(card.getByText(HERO_POOL_INVITE.body)).toBeVisible();
    await expect(card.getByText(HERO_POOL_INVITE.smallPrint)).toBeVisible();
    const join = card.getByRole("link", { name: HERO_POOL_INVITE.cta.label });
    await expect(join).toHaveAttribute("href", "/play?src=site-hero");
    const b = (await join.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    // Both audiences early: the organisers' button is on the first screen too.
    await expect(page.locator("#hero").getByRole("link", { name: HERO.primary.label })).toBeInViewport();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("the headline's full stops sit against their words: no space in the text, and each stop pulled back", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  const lines = page.locator("#hero h1 > span");
  await expect(lines).toHaveCount(2);
  for (const [i, text] of [HERO.titleLead, HERO.titleTail].entries()) {
    const line = lines.nth(i);
    expect(await line.evaluate((el) => el.textContent)).toBe(text);
    expect(await line.innerText()).not.toMatch(/\s\./);
    // Plus Jakarta Sans's "." starts its ink about 0.13em past its origin;
    // the stop is pulled back by 0.1em (tight-stops.tsx).
    const pull = await line.locator("[data-stop]").evaluate((el) => parseFloat(getComputedStyle(el).marginLeft));
    expect(pull).toBeLessThan(0);
  }
  await expect(page.locator("#hero h1")).toHaveText("Your players WhatsApp.MatchTime runs the game.");
});

test("phone: the pool section is compact, the offer and all four steps within about 1.5 screens after its headline", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  const section = page.locator("section#player-pool");
  const top = (await section.getByRole("heading", { level: 2 }).boundingBox())!;
  const pool = LANDING_SPOTLIGHTS.find((s) => s.id === "player-pool")!;
  const lastStep = (await section.getByRole("heading", { level: 3, name: pool.steps!.at(-1)!.title }).boundingBox())!;
  const offer = (await section.getByRole("figure").boundingBox())!;
  const end = Math.max(lastStep.y + lastStep.height + 60, offer.y + offer.height);
  expect(end - (top.y + top.height)).toBeLessThanOrEqual(PHONE.height * 1.6);
  const total = (await section.boundingBox())!.height;
  expect(total).toBeLessThan(3000);
});

test("section order (round three, 2026-10-27): hero, attendance, short of players, the player pool, then the rest", async ({ page }) => {
  await open(page);
  const ids = await page.evaluate(() => {
    const hero = document.getElementById("hero")!;
    const out: string[] = [];
    let el = hero.nextElementSibling;
    while (el && out.length < 4) {
      if (el.id) out.push(el.id);
      el = el.nextElementSibling;
    }
    return out;
  });
  expect(ids).toEqual(["features", "short-of-players", "player-pool", "more-features"]);
  // The attendance section holds the first three feature cards: who's in,
  // short of players, the bench.
  const cards = page.locator("section#features").getByRole("heading", { level: 3 });
  await expect(cards).toHaveCount(3);
  const pool = LANDING_SPOTLIGHTS.find((s) => s.id === "player-pool")!;
  const section = page.locator("section#player-pool");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { level: 2, name: pool.title })).toBeVisible();
  await expect(section.getByText(pool.benefit!)).toBeVisible();
  await expect(section.getByRole("figure", { name: /Private message to a player in the pool/ })).toBeVisible();
  await expect(section.getByText("Would you like the place? Reply here, or tap to answer:")).toBeVisible();
});

for (const width of [375, 390]) {
  test(`phone ${width}: the short-of-players section starts within about four screens of the top`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    const section = page.locator("section#short-of-players");
    const top = await section.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(top).toBeLessThan(844 * 4);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    if (SHOTS) {
      await section.evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY, behavior: "instant" }));
      await page.waitForTimeout(300);
      await shot(page, `short-of-players-${width}.png`);
      await page.evaluate(() => window.scrollBy({ top: 800, behavior: "instant" }));
      await page.waitForTimeout(300);
      await shot(page, `short-of-players-${width}-b.png`);
    }
  });
}

/**
 * Gradient headline text is painted with background-clip: text, and the
 * background stops at the element's box. Measured 2026-10-27 at 360 to 430
 * wide: the h1 is 36px at line-height 1.08 (38.88px), the tail wraps to
 * "game." on its own line, and the "g" descender's ink ran 2px below the
 * span's box, so the bottom of the "g" was not painted. The check: every
 * gradient-text element's box contains the ink of its text.
 */
for (const width of [360, 375, 390, 393, 412, 430]) {
  test(`gradient text keeps its descenders at ${width} wide (the "g" of "game")`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    await page.evaluate(() => document.fonts.ready);
    const clipped = await page.evaluate(() => {
      const out: Array<{ text: string; inkBottom: number; boxBottom: number }> = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const cs = getComputedStyle(el);
        const clip = cs.backgroundClip || cs.getPropertyValue("-webkit-background-clip");
        if (!/text/.test(clip)) continue;
        const text = el.textContent ?? "";
        if (!text.trim()) continue;
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const box = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        let inkBottom = -Infinity;
        for (const r of Array.from(range.getClientRects())) {
          // A client rect is the font's content area; the baseline sits the
          // font's descent above its bottom, and the ink runs the glyphs'
          // own descent below the baseline.
          const m = ctx.measureText(text);
          inkBottom = Math.max(inkBottom, r.bottom - m.fontBoundingBoxDescent + m.actualBoundingBoxDescent);
        }
        if (inkBottom > box.bottom + 0.5) out.push({ text: text.slice(0, 40), inkBottom, boxBottom: box.bottom });
      }
      return out;
    });
    expect(clipped).toEqual([]);
    if (width === 390 || width === 375) await shot(page, `hero-top-${width}.png`);
  });
}

for (const key of ["ratings", "stats"] as const) {
  for (const width of [375, 390]) {
    test(`phone ${width}: the ${key} card's sheet draws the real ${key === "ratings" ? "rating page" : "stats page"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await open(page);
      const card = HERO_DECK.cards.find((c) => c.key === key)!;
      await cardButton(page, card.title).click();
      const sheet = page.getByRole("dialog", { name: card.title });
      await expect(sheet).toBeVisible();
      const sketch = sheet.getByRole("figure", { name: key === "ratings" ? "The rating page a player opens" : "A player's stats page" });
      await expect(sketch).toBeAttached();
      if (key === "ratings") {
        await expect(sketch.getByText("Rate players", { exact: true })).toBeAttached();
        await expect(sketch.getByText("Submit ratings")).toBeAttached();
      } else {
        await expect(sketch.getByText(/^Badges/)).toBeAttached();
        await expect(sketch.getByText("MoM Machine")).toBeAttached();
      }
      // The sketch fits the sheet: nothing runs off to the side.
      const sb = (await sketch.boundingBox())!;
      expect(sb.x).toBeGreaterThanOrEqual(0);
      expect(sb.x + sb.width).toBeLessThanOrEqual(width);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await sketch.scrollIntoViewIfNeeded();
      await shot(page, `sheet-${key}-${width}.png`);
    });
  }
}

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
