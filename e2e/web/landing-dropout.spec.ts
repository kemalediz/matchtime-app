/**
 * The home page's dropout story (variant D, 2026-10-26): right after the
 * hero, "What happens when a player drops out on match day", a drawn group
 * chat and a timeline. Phone left and timeline right on desktop, stacked
 * on a phone, no sideways scroll; MatchTime's messages are its real
 * strings; nothing about pricing. No model calls: $0.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { DROPOUT_STORY } from "@/components/landing/landing-content";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const [name, size] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`the dropout story follows the hero and reads on ${name} width`, async ({ page }) => {
    await page.setViewportSize(size);
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    const d = DROPOUT_STORY;
    const section = page.getByRole("region", { name: d.title });
    await expect(section).toHaveCount(1);

    // Directly after the hero: the second section on the page.
    expect(await page.locator("main section, body section").nth(1).getAttribute("id")).toBe(d.id);

    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("heading", { level: 2, name: d.title })).toBeVisible();
    await expect(section.getByText(d.lead)).toBeVisible();

    const chat = section.getByRole("figure", { name: d.chat.caption });
    await expect(chat).toBeVisible();
    await expect(chat.getByText("Can't make it tonight lads, I'm out")).toBeVisible();
    // The bot's own words (strings.en.ts), drawn without emoji.
    await expect(chat).toContainText("A slot just opened for Thursday 7-a-side tonight. First to claim it plays.");
    await expect(chat).toContainText("Just reply IN here to take it.");
    await expect(chat).toContainText("Kai is in, replacing Joe. Squad 14/14");
    await expect(chat).toContainText("@Match Time make teams");

    const timeline = section.getByRole("list", { name: "Timeline" });
    for (const s of d.timeline) {
      await expect(timeline.getByRole("heading", { level: 3, name: s.title })).toBeVisible();
      await expect(timeline.getByText(s.body)).toBeVisible();
    }

    const [chatBox, tlBox] = [await chat.boundingBox(), await timeline.boundingBox()];
    if (name === "desktop") {
      // Phone on the left, timeline on the right.
      expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(tlBox!.x);
    } else {
      expect(chatBox!.y + chatBox!.height).toBeLessThanOrEqual(tlBox!.y);
      const cta = section.getByRole("link", { name: d.cta.label });
      await expect(cta).toHaveAttribute("href", d.cta.href);
      expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await expect(section).not.toContainText(/£|pay only|weeks you play|a month|months free|price/i);
    await expect(section).not.toContainText(/waiting list|a week/i);
    expect(await section.innerText()).not.toMatch(/[—–]/);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/landing-dropout-${name}.png`, fullPage: false });
  });
}
