/**
 * The one-line player pool banner on every signed-in page (2026-10-28), in
 * a real browser: join for a member not in the pool (its ⓘ, and "Join the
 * pool" landing on the highlighted "Play elsewhere too" card), share once
 * he is in the pool (his own link in a wa.me message), "Not interested"
 * holding across a reload and on other pages (stored on his user row),
 * join dismissed then joining still shows share, hidden while the club's
 * pool or the platform is off and on public pages, the admin line, Turkish,
 * and phone width. Solid blue and sticky under the top bar (2026-10-28):
 * it stays in view while a long page scrolls, at phone width and desktop.
 * Without a reload (2026-10-28): joining on the "Play elsewhere too" card
 * turns join into share at once, and a dismiss in one tab hides it in
 * another. No model, no messages, Google is a stub: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, signInAs, U } from "../fixtures";
import { setPoolPlatform } from "../helpers/pool-platform";
import { ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";
import { poolBannerCopy } from "@/lib/i18n/pool-banner";
import { poolShareCopy } from "@/lib/i18n/pool-share";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";

const EN = poolBannerCopy("en");
const TR = poolBannerCopy("tr");
const PHONE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };
const SHOTS = "/private/tmp/claude-501/-Users-kemal-Projects-Cressoft-Sports-matchtime/53efc5e1-1f7c-48ce-a74b-cc3c6361bf47/scratchpad/pool-banner-v2";
const SHARE_KEY = `org-${ORG_ID}:pool-club-share`;

test.describe.configure({ mode: "serial" });

const banner = (page: Page) => page.getByTestId("pool-banner");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function seedActiveProfile(db: TestDb, userId: string) {
  await db.run(`DELETE FROM "PoolProfile" WHERE "userId" = $1`, [userId]);
  await db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt",
       "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "createdAt", "updatedAt")
     VALUES ($1, $2, 'active', now(), 1, 'web', 'e2e', now(), 'Pat Player', 'SM1', 51.36, -0.19, 3, 'profile', now(), now())`,
    [`e2e-banner-${userId}`, userId],
  );
}

const dismissals = (db: TestDb, userId: string) =>
  db.one<{ j: Date | null; s: Date | null }>(`SELECT "poolBannerJoinDismissedAt" AS j, "poolBannerShareDismissedAt" AS s FROM "User" WHERE id = $1`, [userId]);

async function reset(db: TestDb) {
  await setPoolPlatform(db, true);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true, language = 'en' WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "User" SET "poolBannerJoinDismissedAt" = NULL, "poolBannerShareDismissedAt" = NULL WHERE id IN ($1, $2)`, [U.player, U.admin]);
  await db.run(`DELETE FROM "PoolProfile" WHERE "userId" IN ($1, $2)`, [U.player, U.admin]);
  await db.run(`DELETE FROM "SentNotification" WHERE key = $1`, [SHARE_KEY]);
}

test.beforeEach(async ({ db }) => reset(db));
test.afterAll(async ({ db }) => {
  await reset(db);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false WHERE id = $1`, [ORG_ID]);
  await setPoolPlatform(db, false);
});

test("phone: join, its ⓘ, and Join the pool lands on the highlighted Play elsewhere too card", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, U.player, "/");
  const b = banner(page);
  await expect(b).toBeVisible({ timeout: 30_000 });
  await expect(b).toHaveAttribute("data-kind", "join");
  await expect(b.getByTestId("pool-banner-text")).toContainText(EN.join.text);
  await expect(b.getByTestId("pool-banner-join")).toHaveText(EN.join.button);
  await expect(b.getByTestId("pool-banner-dismiss")).toHaveText(EN.notInterested);
  await expect(b.getByTestId("pool-banner-admin")).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // Compact: the line and its buttons, never taller than a few rows.
  expect((await b.boundingBox())!.height).toBeLessThan(110);
  await page.screenshot({ path: `${SHOTS}/phone-join-dashboard.png` });

  await page.getByTestId("info-pool-banner").click();
  const dialog = page.getByRole("dialog", { name: EN.join.info.title });
  await expect(dialog).toBeVisible();
  for (const line of EN.join.info.lines) await expect(dialog).toContainText(line);
  await page.waitForTimeout(500); // the sheet's slide-in, for the picture only
  await page.screenshot({ path: `${SHOTS}/phone-join-info.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await b.getByTestId("pool-banner-join").click();
  await page.waitForURL("**/profile#play-elsewhere");
  const card = page.getByTestId("play-elsewhere");
  await expect(card).toHaveAttribute("data-highlight", "on", { timeout: 30_000 });
  await expect(card).toBeInViewport();
  // Let the smooth scroll settle before the picture.
  await expect
    .poll(() => page.evaluate(async () => { const a = window.scrollY; await new Promise((r) => setTimeout(r, 250)); return window.scrollY - a; }))
    .toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // The sticky banner never hides the top of the card it scrolled to.
  expect((await card.boundingBox())!.y).toBeGreaterThanOrEqual((await edges(page)).bottom);
  await page.screenshot({ path: `${SHOTS}/phone-join-lands-on-card.png` });
});

/**
 * The banner's computed background and text colour as sRGB, and the WCAG
 * contrast between them. Tailwind 4 computes to oklch(), so each colour is
 * painted on a 1px canvas and read back as RGB.
 */
async function colours(page: Page) {
  return banner(page).evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgb = (css: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bg = rgb(getComputedStyle(el).backgroundColor);
    const fg = rgb(getComputedStyle(el).color);
    const [hi, lo] = [lum(bg), lum(fg)].sort((a, b) => b - a);
    return { bg, fg, bgLum: lum(bg), contrast: (hi + 0.05) / (lo + 0.05) };
  });
}

/** Its top edge, and the bottom edge of the nav above it (the phone's top bar; desktop has none, so 0). */
async function edges(page: Page) {
  return page.evaluate(() => {
    const b = document.querySelector('[data-testid="pool-banner"]')!.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="mobile-topbar"]');
    const r = bar?.getBoundingClientRect();
    const navBottom = r && r.height > 0 ? r.bottom : 0;
    return { top: b.top, bottom: b.bottom, navBottom, scrollY: window.scrollY };
  });
}

test("the banner is on the other signed-in pages too, under the nav, solid blue, never over the content", async ({ page }) => {
  await page.setViewportSize(PHONE);
  for (const path of ["/profile", "/matches", "/profile/stats"]) {
    await signInAs(page, U.player, path);
    const b = banner(page);
    await expect(b).toBeVisible({ timeout: 30_000 });
    expect(await b.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
    // Clearly visible: a dark saturated blue with white text (the pale
    // strip it used to be, bg-blue-50, has a luminance above 0.9), AA contrast.
    const c = await colours(page);
    expect(c.bgLum).toBeLessThan(0.2);
    expect(c.bg[2]).toBeGreaterThan(c.bg[0] + 100); // blue, not grey
    expect(c.fg).toEqual([255, 255, 255]);
    expect(c.contrast).toBeGreaterThanOrEqual(4.5);
    // At the top of the page it sits right under the top bar, and the
    // content starts below it (it holds its own height in the flow).
    const e = await edges(page);
    expect(Math.abs(e.top - e.navBottom)).toBeLessThanOrEqual(1);
    const next = await b.evaluate((el) => el.nextElementSibling?.getBoundingClientRect().top ?? Infinity);
    expect(next).toBeGreaterThanOrEqual(e.bottom - 1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  }
});

for (const [name, size] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`${name}: sticky, it stays pinned under the nav while a long page scrolls`, async ({ page }) => {
    await page.setViewportSize(size);
    await signInAs(page, U.player, "/profile");
    const b = banner(page);
    await expect(b).toBeVisible({ timeout: 30_000 });
    // Make sure the page is long enough to scroll, whatever the fixture data.
    await page.evaluate(() => {
      const pad = document.createElement("div");
      pad.style.height = "3000px";
      pad.setAttribute("data-testid", "e2e-scroll-pad");
      document.querySelector("main")!.appendChild(pad);
    });
    // Far enough that the banner's own place in the flow is long gone, near
    // enough that the picture still shows the page's content under it.
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(400);
    expect((await edges(page)).top).toBeGreaterThanOrEqual(0);
    await expect(b).toBeInViewport();
    const e = await edges(page);
    expect(Math.abs(e.top - e.navBottom)).toBeLessThanOrEqual(1);
    if (name === "phone") {
      expect(e.navBottom).toBeGreaterThan(0);
      await expect(page.getByTestId("mobile-topbar")).toBeInViewport();
    } else {
      expect(e.top).toBeLessThanOrEqual(1);
    }
    // Its buttons still work while pinned.
    await expect(b.getByTestId("pool-banner-join")).toBeInViewport();
    await page.screenshot({ path: `${SHOTS}/${name}-scrolled-sticky.png` });
  });
}

test("never on public pages", async ({ page }) => {
  await signInAs(page, U.player, "/privacy");
  await page.waitForLoadState("networkidle");
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/play");
  await page.waitForLoadState("networkidle");
  await expect(banner(page)).toHaveCount(0);
});

test("Not interested on join holds across a reload and on another page, stored on his user row", async ({ page, db }) => {
  await signInAs(page, U.player, "/");
  await expect(banner(page)).toBeVisible({ timeout: 30_000 });
  await banner(page).getByTestId("pool-banner-dismiss").click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await dismissals(db, U.player))?.j ?? null).not.toBeNull();
  expect((await dismissals(db, U.player))?.s).toBeNull();

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/profile");
  await expect(page.getByTestId("play-elsewhere")).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
});

for (const [name, size] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`${name}: in the pool, share his own link on WhatsApp`, async ({ page, db }) => {
    await seedActiveProfile(db, U.player);
    await page.setViewportSize(size);
    await signInAs(page, U.player, "/");
    const b = banner(page);
    await expect(b).toHaveAttribute("data-kind", "share", { timeout: 30_000 });
    await expect(b.getByTestId("pool-banner-text")).toContainText(EN.share.text);
    const share = b.getByTestId("pool-banner-share");
    await expect(share).toHaveText(EN.share.button);
    const code = (await db.one<{ shareCode: string }>(`SELECT "shareCode" FROM "PoolProfile" WHERE "userId" = $1`, [U.player]))!.shareCode;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    const href = await share.getAttribute("href");
    expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
    const text = decodeURIComponent(href!.split("text=")[1]);
    expect(text).toMatch(new RegExp(`/play\\?ref=${code}$`));
    expect(text).toBe(poolShareCopy("en").message(text.slice(text.lastIndexOf("http"))));
    await expect(share).toHaveAttribute("target", "_blank");
    await b.getByTestId("info-pool-banner").click();
    const dialog = page.getByRole("dialog", { name: EN.share.info.title });
    for (const line of EN.share.info.lines) await expect(dialog).toContainText(line);
    await page.keyboard.press("Escape");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/${name}-share.png` });
  });
}

test("join dismissed, then he joins: the share banner still shows once; dismissing it holds", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "poolBannerJoinDismissedAt" = now() WHERE id = $1`, [U.player]);
  await signInAs(page, U.player, "/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);

  await seedActiveProfile(db, U.player);
  await page.reload();
  await expect(banner(page)).toHaveAttribute("data-kind", "share", { timeout: 30_000 });
  await banner(page).getByTestId("pool-banner-dismiss").click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(async () => (await dismissals(db, U.player))?.s ?? null).not.toBeNull();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);
});

test("hidden while the club's pool is off, and while the platform is off", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.player, "/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);

  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);
  await setPoolPlatform(db, false);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toHaveCount(0);

  // On again: back on the next page, nothing cached.
  await setPoolPlatform(db, true);
  await page.reload();
  await expect(banner(page)).toBeVisible({ timeout: 30_000 });
});

test("the admin line for an owner whose club has not told its players, gone once it has", async ({ page, db }) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, U.admin, "/admin");
  const b = banner(page);
  await expect(b).toBeVisible({ timeout: 30_000 });
  const line = b.getByTestId("pool-banner-admin");
  await expect(line).toHaveText(EN.adminLine);
  await expect(line).toHaveAttribute("href", "/admin/settings#pool-club-share");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/phone-admin-line.png` });

  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "createdAt") VALUES ('e2e-banner-share-claim', $1, 'pool-club-share', now())`, [SHARE_KEY]);
  await page.reload();
  await expect(b).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId("pool-banner-admin")).toHaveCount(0);
});

test("before the migration (the columns missing): no banner, and the pages still work", async ({ page, db }) => {
  await db.run(`ALTER TABLE "User" RENAME COLUMN "poolBannerJoinDismissedAt" TO "e2eHiddenJoin"`);
  await db.run(`ALTER TABLE "User" RENAME COLUMN "poolBannerShareDismissedAt" TO "e2eHiddenShare"`);
  try {
    for (const path of ["/", "/profile", "/admin"]) {
      await signInAs(page, U.admin, path);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
      await expect(banner(page)).toHaveCount(0);
    }
  } finally {
    await db.run(`ALTER TABLE "User" RENAME COLUMN "e2eHiddenJoin" TO "poolBannerJoinDismissedAt"`);
    await db.run(`ALTER TABLE "User" RENAME COLUMN "e2eHiddenShare" TO "poolBannerShareDismissedAt"`);
  }
  await page.reload();
  await expect(banner(page)).toBeVisible({ timeout: 30_000 });
});

test("Turkish club: the Turkish banner", async ({ page, db }) => {
  await page.setViewportSize(PHONE);
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/");
  const b = banner(page);
  await expect(b).toBeVisible({ timeout: 30_000 });
  await expect(b).toHaveAttribute("lang", "tr");
  await expect(b.getByTestId("pool-banner-text")).toContainText(TR.join.text);
  await expect(b.getByTestId("pool-banner-join")).toHaveText(TR.join.button);
  await expect(b.getByTestId("pool-banner-dismiss")).toHaveText(TR.notInterested);
  await expect(b.getByTestId("pool-banner-admin")).toHaveText(TR.adminLine);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/phone-turkish.png` });

  await seedActiveProfile(db, U.admin);
  await db.run(`UPDATE "PoolProfile" SET language = 'tr' WHERE "userId" = $1`, [U.admin]);
  await page.reload();
  await expect(b).toHaveAttribute("data-kind", "share", { timeout: 30_000 });
  await expect(b.getByTestId("pool-banner-text")).toContainText(TR.share.text);
  await expect(b.getByTestId("pool-banner-share")).toHaveText(TR.share.button);
  await page.screenshot({ path: `${SHOTS}/phone-turkish-share.png` });
});

/** Google's answer for his club's postcode area, which the card's join places. */
const SM1 = {
  status: "OK",
  results: [
    {
      place_id: "e2e-banner-district",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.3656, lng: -0.1963 }, location_type: "APPROXIMATE" },
      types: ["postal_code_prefix"],
      address_components: [{ short_name: "GB", types: ["country"] }],
    },
  ],
};

test("he joins on the Play elsewhere too card: the banner turns to share at once, no reload", async ({ page, db }) => {
  // His club's pitch, whose postcode area the card fills in (as play-elsewhere.spec does).
  setGeocodeStub({ geocode: { "*": { body: SM1 } } });
  const before = await db.one<{ venueId: string | null }>(`SELECT "venueId" FROM "Activity" WHERE id = 'e2e-activity'`);
  await db.run(
    `INSERT INTO "Venue" (id, "placeId", name, "formattedAddress", lat, lng, source, "createdAt", "updatedAt")
     VALUES ('e2e-banner-v1', 'ChIJ_e2e_banner_v1', 'Riverside Sports Centre', 'River Road, Sutton SM1 2EY, UK', 51.36, -0.19, 'google', now(), now()) ON CONFLICT DO NOTHING`,
  );
  await db.run(`UPDATE "Activity" SET "venueId" = 'e2e-banner-v1' WHERE id = 'e2e-activity'`);
  try {
    const P = poolPageCopy("en");
    await signInAs(page, U.player, "/profile");
    const b = banner(page);
    await expect(b).toHaveAttribute("data-kind", "join", { timeout: 30_000 });
    // Any reload would wipe this marker, so the test proves there was none.
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

    const c = page.getByTestId("play-elsewhere");
    await c.getByRole("button", { name: P.member.open }).click();
    await c.getByRole("checkbox", { name: P.signup.adultLabel }).check();
    await c.getByRole("checkbox", { name: P.signup.consentLabel }).check();
    await c.getByRole("button", { name: P.member.join }).click();
    await expect(c.getByText(P.member.inPool)).toBeVisible({ timeout: 30_000 });
    expect((await db.one<{ status: string }>(`SELECT status FROM "PoolProfile" WHERE "userId" = $1`, [U.player]))?.status).toBe("active");

    await expect(b).toHaveAttribute("data-kind", "share", { timeout: 10_000 });
    await expect(b.getByTestId("pool-banner-text")).toContainText(EN.share.text);
    await expect(b.getByTestId("pool-banner-share")).toHaveText(EN.share.button);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    await expect(page).toHaveURL(/\/profile$/);
  } finally {
    clearGeocodeStub();
    await db.run(`UPDATE "Activity" SET "venueId" = $1 WHERE id = 'e2e-activity'`, [before?.venueId ?? null]);
  }
});

test("Not interested in one tab hides the banner in his other tab, no reload", async ({ page, context }) => {
  await signInAs(page, U.player, "/");
  await expect(banner(page)).toHaveAttribute("data-kind", "join", { timeout: 30_000 });
  const other = await context.newPage();
  await other.goto("/profile");
  await expect(banner(other)).toHaveAttribute("data-kind", "join", { timeout: 30_000 });

  await banner(page).getByTestId("pool-banner-dismiss").click();
  await expect(banner(page)).toHaveCount(0);
  await expect(banner(other)).toHaveCount(0, { timeout: 10_000 });
  await other.close();
});
