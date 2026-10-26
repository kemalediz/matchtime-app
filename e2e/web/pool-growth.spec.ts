/**
 * Growth slice G1 of the local player pool, in a real browser:
 *   - "Bring a friend" on /play/manage and on the /profile "Play elsewhere
 *     too" card, at phone and desktop width: his /play?ref= link, Copy puts
 *     it on the clipboard, Share on WhatsApp opens WhatsApp's chat picker
 *     with the ready-to-forward message (no number in it);
 *   - the owner's source codes page: a club admin is not shown the tab and
 *     gets 404 on the page and on the QR download; the owner makes a code,
 *     gets its /play?src= link, sees the sign-ups it brought, downloads its
 *     QR code as PNG and SVG, switches it off;
 *   - /play?src= through the real form stamps the campaign; the home page's
 *     pulsing button still opens /play.
 * Google is a stub; no model anywhere: $0.
 */
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { poolShareCopy } from "@/lib/i18n/pool-share";

const EN = poolPageCopy("en");
const SHARE = poolShareCopy("en");
const MOBILE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-growth-district",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.36, lng: -0.19 }, location_type: "APPROXIMATE" },
      types: ["postal_code_prefix"],
      address_components: [{ short_name: "GB", types: ["country"] }],
    },
  ],
};

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  resetDb();
  setGeocodeStub({ geocode: { "*": { body: UK_POINT } } });
});
test.afterAll(async ({ db }) => {
  clearGeocodeStub();
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A live pool profile for a seeded user (the CHECKs' minimum). */
async function seedPoolProfile(db: TestDb, userId: string, displayName: string) {
  await db.run(`DELETE FROM "PoolProfile" WHERE "userId" = $1`, [userId]);
  await db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt",
       "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "createdAt", "updatedAt")
     VALUES ($1, $2, 'active', now(), 1, 'web', 'e2e', now(), $3, 'SM1', 51.36, -0.19, 3, 'profile', now(), now())`,
    [`e2e-growth-${userId}`, userId, displayName],
  );
}

test.describe("Bring a friend", () => {
  test.use({ locale: "en-GB", permissions: ["clipboard-read", "clipboard-write"] });

  for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
    test(`${name}: the manage page's card, Copy and Share on WhatsApp`, async ({ page, db }) => {
      await seedPoolProfile(db, U.player, "Pat Player");
      await page.setViewportSize(size);
      await signInAs(page, U.player, "/play/manage");
      const card = page.getByTestId("pool-share-card");
      await expect(card.getByRole("heading", { name: SHARE.heading })).toBeVisible({ timeout: 30_000 });

      const url = await page.getByTestId("pool-share-link").inputValue();
      expect(url).toMatch(/\/play\?ref=[A-Z2-9]{6}$/);
      const code = url.split("ref=")[1];
      expect((await db.one<{ shareCode: string }>(`SELECT "shareCode" FROM "PoolProfile" WHERE "userId" = $1`, [U.player]))!.shareCode).toBe(code);

      await card.getByRole("button", { name: SHARE.copyLink }).click();
      await expect(card.getByRole("button", { name: SHARE.copied })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

      const wa = card.getByRole("link", { name: SHARE.shareWhatsApp });
      await expect(wa).toHaveAttribute("href", `https://wa.me/?text=${encodeURIComponent(SHARE.message(url))}`);
      await expect(wa).toHaveAttribute("target", "_blank");
      await expect(page.getByTestId("pool-share-message")).toHaveText(SHARE.message(url));
      await expect(page.getByTestId("pool-share-privacy")).toHaveText(SHARE.recognitionOn("Pat P."));
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test("the /profile card shows the same link to a member in the pool", async ({ page, db }) => {
    await seedPoolProfile(db, U.player, "Pat Player");
    const code = (await db.one<{ shareCode: string | null }>(`SELECT "shareCode" FROM "PoolProfile" WHERE "userId" = $1`, [U.player]))!.shareCode;
    await page.setViewportSize(MOBILE);
    await signInAs(page, U.player, "/profile");
    const card = page.getByTestId("play-elsewhere");
    await expect(card.getByText(EN.member.inPool)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("pool-share-card")).toBeVisible();
    const url = await card.getByTestId("pool-share-link").inputValue();
    expect(url).toMatch(/\/play\?ref=[A-Z2-9]{6}$/);
    if (code) expect(url.endsWith(code)).toBe(true);
    await expect(card.getByRole("link", { name: SHARE.shareWhatsApp })).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("a stopped profile has no card", async ({ page, db }) => {
    await seedPoolProfile(db, U.player, "Pat Player");
    await db.run(`UPDATE "PoolProfile" SET status = 'stopped', "stoppedAt" = now() WHERE "userId" = $1`, [U.player]);
    await signInAs(page, U.player, "/play/manage");
    await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.stopped, { timeout: 30_000 });
    await expect(page.getByTestId("pool-share-card")).toHaveCount(0);
  });
});

test.describe("the owner's source codes", () => {
  test("a club admin: no tab, the page and the QR download answer 404", async ({ page, db }) => {
    await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ('e2e-hidden', 'other', 'hidden') ON CONFLICT DO NOTHING`);
    await signInAs(page, U.admin, "/admin");
    await page.waitForURL("**/admin");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Pool codes", exact: true })).toHaveCount(0);

    expect((await page.goto("/admin/pool/campaigns"))?.status()).toBe(404);
    await expect(page.getByText("Player pool source codes")).toHaveCount(0);
    const qr = await page.request.get("/admin/pool/campaigns/e2e-hidden/qr?format=png");
    expect(qr.status()).toBe(404);
    expect(qr.headers()["content-type"]).not.toContain("image");
  });

  for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
    test(`${name}: the owner makes a code, sees its link and its sign-ups, downloads its QR code, switches it off`, async ({ page, db }) => {
      const codeName = `leaflet-sutton-${name}`;
      await db.run(`DELETE FROM "PoolCampaign" WHERE code = $1`, [codeName]);
      await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
      await page.setViewportSize(size);
      await signInAs(page, U.admin, "/admin/pool/campaigns");
      await expect(page.getByRole("heading", { name: "Player pool source codes" })).toBeVisible({ timeout: 30_000 });
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      // A bad code names the problem and makes nothing.
      await page.getByLabel("Code", { exact: true }).fill("Bad code!");
      await page.getByLabel("What it is for").fill("Sutton leaflets, October");
      await page.getByRole("button", { name: "Make code" }).click();
      await expect(page.getByText("Lowercase letters, digits and single hyphens only")).toBeVisible();

      await page.getByLabel("Code", { exact: true }).fill(codeName);
      await page.getByLabel("Where it is shared").selectOption("leaflet");
      await page.getByRole("button", { name: "Make code" }).click();
      await expect(page.getByRole("status").filter({ hasText: `Code ${codeName} is ready.` })).toBeVisible();
      expect(await db.one(`SELECT source, label, active FROM "PoolCampaign" WHERE code = $1`, [codeName])).toEqual({ source: "leaflet", label: "Sutton leaflets, October", active: true });

      // The same code again: taken.
      await page.getByLabel("Code", { exact: true }).fill(codeName);
      await page.getByLabel("What it is for").fill("again");
      await page.getByRole("button", { name: "Make code" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "That code is taken. Pick another." })).toBeVisible();

      // Sign-ups it brought: two confirmed, one still waiting.
      for (const [i, status] of (["active", "paused", "pending-verify"] as const).entries()) {
        const live = status !== "pending-verify";
        await db.run(
          `INSERT INTO "PoolProfile" (id, "userId", status, "pausedReason", "pausedAt", "consentAt", "consentVersion", "consentChannel", "consentEvidence",
             "adultConfirmedAt", "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "sourceCode", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), 'Someone S', 'SM1', 51.36, -0.19, 3, 'campaign', $10, now(), now())`,
          [
            `e2e-camp-${name}-${i}`,
            live ? (i === 0 ? U.rater : U.bench) : null,
            status,
            status === "paused" ? "self" : null,
            status === "paused" ? new Date() : null,
            live ? new Date() : null,
            live ? 1 : null,
            live ? "web" : null,
            live ? "e2e" : null,
            codeName,
          ],
        );
      }
      await page.reload();
      const row = page.locator(`[data-testid="campaign-row"][data-code="${codeName}"]`);
      await expect(row.getByTestId("campaign-url")).toHaveText(new RegExp(`/play\\?src=${codeName}$`));
      await expect(row.getByTestId("campaign-confirmed")).toHaveText("2");
      await expect(row.getByTestId("campaign-waiting")).toHaveText("1");
      await expect(row).not.toContainText("Someone");

      // QR downloads: a real PNG and a real SVG, named after the code.
      const [png] = await Promise.all([page.waitForEvent("download"), row.getByRole("link", { name: "QR code (PNG)" }).click()]);
      expect(png.suggestedFilename()).toBe(`matchtime-play-${codeName}.png`);
      const pngBytes = await readFile((await png.path())!);
      expect(pngBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const [svg] = await Promise.all([page.waitForEvent("download"), row.getByRole("link", { name: "QR code (SVG)" }).click()]);
      expect(svg.suggestedFilename()).toBe(`matchtime-play-${codeName}.svg`);
      expect((await readFile((await svg.path())!, "utf8")).startsWith("<svg")).toBe(true);

      // Off: stays listed, stops stamping.
      await row.getByRole("switch", { name: `Code ${codeName} on` }).uncheck();
      await expect.poll(async () => (await db.one<{ active: boolean }>(`SELECT active FROM "PoolCampaign" WHERE code = $1`, [codeName]))!.active).toBe(false);
      await db.run(`DELETE FROM "PoolProfile" WHERE "sourceCode" = $1`, [codeName]);
    });
  }

  test("the owner sees the Pool codes tab", async ({ page, db }) => {
    await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
    await signInAs(page, U.admin, "/admin");
    await expect(page.getByRole("link", { name: "Pool codes", exact: true })).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("/play with codes", () => {
  test.use({ locale: "en-GB" });

  test("the home page's hero link still opens /play, with the hero's code", async ({ page }) => {
    await page.goto("/");
    // Round two (2026-10-26): the hero's way in is the players card's button.
    const cta = page.locator("#hero").getByTestId("hero-pool-join");
    await expect(cta).toHaveAttribute("href", "/play?src=site-hero");
    await cta.click();
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible({ timeout: 30_000 });
  });

  test("/play?src= through the real form stamps the campaign", async ({ page, db }) => {
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ('li-kemal-g1', 'linkedin', 'post') ON CONFLICT DO NOTHING`);
    await page.goto("/play?src=li-kemal-g1");
    await page.getByLabel(EN.fields.nameLabel, { exact: true }).fill("Lin Kedin");
    await page.getByLabel(EN.fields.districtLabel, { exact: true }).fill("sm1");
    await page.getByRole("checkbox", { name: "Tuesday", exact: true }).check();
    await page.getByLabel(EN.fields.fromLabel("Tuesday")).selectOption("19:00");
    await page.getByLabel(EN.fields.toLabel("Tuesday")).selectOption("22:00");
    await page.getByRole("checkbox", { name: "7-a-side" }).check();
    await page.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
    await page.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
    await page.getByRole("button", { name: EN.signup.submit }).click();
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.confirmHeading })).toBeVisible();
    const code = (await page.getByTestId("pool-code").innerText()).trim();
    expect(await db.one(`SELECT source, "sourceCode" FROM "PoolProfile" WHERE "confirmCode" = $1`, [code])).toEqual({ source: "campaign", sourceCode: "li-kemal-g1" });
  });
});
