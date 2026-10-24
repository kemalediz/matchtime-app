/**
 * "Ask the player pool automatically" on /admin/settings (local player pool,
 * slice L9): shown only while the club may ask the pool, beside Style of
 * play; off for a new club; the switch saves `Organisation.poolAutoAsk`
 * both ways; English and Turkish; phone and desktop width. The automatic
 * ask itself is e2e/sim/pool/auto-ask.spec.ts.
 */
import { test, expect, signInAs, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

async function stored(db: import("../helpers/test-db").TestDb): Promise<boolean | undefined> {
  return (await db.one<{ on: boolean }>(`SELECT "poolAutoAsk" AS on FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.on;
}

async function openSettings(page: import("@playwright/test").Page) {
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

test.afterEach(async ({ db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false, "poolAutoAsk" = false, language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("hidden while the club may not ask the pool", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false, "poolAutoAsk" = true WHERE id = $1`, [ORG_ID]);
  await openSettings(page);
  await expect(page.getByTestId("pool-auto-ask")).toHaveCount(0);
});

for (const [label, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`shown with the pool on, off by default, and saved both ways (${label})`, async ({ page, db }) => {
    await page.setViewportSize(viewport);
    await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true, "poolAutoAsk" = false WHERE id = $1`, [ORG_ID]);
    await openSettings(page);

    const card = page.getByTestId("pool-auto-ask");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("heading", { name: "Ask the player pool automatically" })).toBeVisible();
    await expect(card).toContainText("an hour after your partner clubs, or straight away if you have none");
    await expect(page.getByTestId("info-setting-poolAutoAsk")).toBeVisible();
    // Beside Style of play: the next card down.
    const styleBox = await page.getByTestId("play-style").boundingBox();
    const autoBox = await card.boundingBox();
    expect(styleBox && autoBox && autoBox.y > styleBox.y).toBe(true);
    // Nothing runs off the side on a phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const sw = page.getByRole("switch", { name: "Ask the player pool automatically" });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("MatchTime will ask the player pool automatically.")).toBeVisible();
    await expect.poll(() => stored(db), { timeout: 15_000 }).toBe(true);

    await page.reload();
    const again = page.getByRole("switch", { name: "Ask the player pool automatically" });
    await expect(again).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    await again.click();
    await expect(again).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => stored(db), { timeout: 15_000 }).toBe(false);
  });
}

test("a Turkish club reads the card in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true, language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const card = page.getByTestId("pool-auto-ask");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading", { name: "Oyuncu havuzuna kendiliğinden sor" })).toBeVisible();
  await expect(card).toContainText("partner kulüplerinizden bir saat sonra");
  await page.getByRole("switch", { name: "Oyuncu havuzuna kendiliğinden sor" }).click();
  await expect(page.getByText("MatchTime oyuncu havuzuna kendiliğinden soracak.")).toBeVisible();
  await expect.poll(() => stored(db), { timeout: 15_000 }).toBe(true);
});
