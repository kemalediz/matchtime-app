/**
 * The pool's two pages (local player pool L5a, 2026-10-24), phone and
 * desktop width:
 *
 *   - the match page's pool tick, for the club's organisers: the band of
 *     players near the venue ("a few near you"), never who; one press asks
 *     the pool; then "Asked 1 nearby player"; in Turkish too;
 *   - the offer page the tap link opens: the game's facts, Yes / No
 *     thanks, the map; yes gives the place; a bad link says so. No
 *     sideways scroll at phone width.
 *
 * Free: no model is called.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs } from "../fixtures";
import { E2E_BASE_URL } from "../helpers/env";
import { PoolWorld } from "../sim/pool/world";
import { at, holderDigits, near, openClub, organiserAsks, pollPlatform, poolPlayer, tapLinkIn } from "../sim/pool/offers-world";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

const WIDTHS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
];

async function poolOpenCookie(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mt-test-pool-open", value: "1", url: E2E_BASE_URL }]);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const vp of WIDTHS) {
  test(`match page (${vp.name}): the pool tick shows a band, never who; one press asks the pool`, async ({ page, request, db }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const world = new PoolWorld(request, db, false);
    await world.start();
    const fnf = await openClub(world, `fnf-${vp.name}`, { name: "FNF" });
    await poolPlayer(world, `ali-${vp.name}`, { name: "Ali Kaya", at: near(fnf) });
    const owner = (await world.userOf(fnf.member("owner")))!;
    await poolOpenCookie(page);

    await signInAs(page, owner.id, `/matches/${fnf.group.matchId}`);
    const row = page.getByTestId("pool-ask-row");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute("data-band", "few");
    await expect(row).toContainText("MatchTime player pool (a few near you)");
    await expect(page.getByTestId("partner-ask-panel")).not.toContainText("Ali");
    await expect(page.getByTestId("pool-ask-tick")).toBeChecked();
    await noSidewaysScroll(page);

    await page.getByTestId("partner-ask-button").click();
    await expect(page.getByTestId("pool-ask-status")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("partner-ask-round")).toContainText("MatchTime player pool");
    const offers = await db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1`, [fnf.group.orgId]);
    expect(offers).toBe(1);
  });
}

test("match page in Turkish: the pool line in the club's language", async ({ page, request, db }) => {
  const world = new PoolWorld(request, db, false);
  await world.start();
  const gs = await openClub(world, "gs-web", { name: "Galata FC" });
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [gs.group.orgId]);
  for (const k of ["c1", "c2", "c3", "c4", "c5"]) await poolPlayer(world, `${k}-tr`, { at: near(gs) });
  const owner = (await world.userOf(gs.member("owner")))!;
  await poolOpenCookie(page);
  await signInAs(page, owner.id, `/matches/${gs.group.matchId}`);
  const row = page.getByTestId("pool-ask-row");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute("data-band", "5+");
  await expect(row).toContainText("MatchTime oyuncu havuzu (yakınınızda 5+ kişi)");
});

test("the pool switch off: no pool line at all, the page as before", async ({ page, request, db }) => {
  const world = new PoolWorld(request, db, false);
  await world.start();
  const fnf = await openClub(world, "fnf-off", { name: "FNF Off" });
  await poolPlayer(world, "ali-off", { at: near(fnf) });
  const owner = (await world.userOf(fnf.member("owner")))!;
  await page.context().addCookies([{ name: "mt-test-pool-open", value: "0", url: E2E_BASE_URL }]);
  await signInAs(page, owner.id, `/matches/${fnf.group.matchId}`);
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pool-ask-row")).toHaveCount(0);
  await expect(page.getByTestId("partner-ask-panel")).toHaveCount(0);
});

for (const vp of WIDTHS) {
  test(`offer page (${vp.name}): the facts, the map, Yes and No thanks; yes gives the place`, async ({ page, request, db }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const world = new PoolWorld(request, db, false);
    await world.start();
    const fnf = await openClub(world, `fnf-o-${vp.name}`, { name: "FNF", feePerPlayer: 6, pool: { playStyle: "mixed" } });
    await poolPlayer(world, `ali-o-${vp.name}`, { at: near(fnf) });
    const ex = await organiserAsks(world, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(world, { now: at(fnf.kickoff, -8) });
    await page.context().clearCookies();
    await poolOpenCookie(page);

    await page.goto(tapLinkIn(ex.sent[0]));
    await expect(page.getByRole("heading")).toHaveText("A game for you");
    const facts = page.getByTestId("pool-offer-facts");
    await expect(facts).toContainText("FNF needs 1 player for a 7-a-side football game");
    await expect(facts).toContainText("Goals North Cheam");
    await expect(facts).toContainText("Mixed levels, everyone welcome");
    await expect(facts).toContainText("£6 match fee");
    await expect(page.getByTestId("pool-offer-map")).toHaveAttribute("href", /google\.com\/maps/);
    await expect(page.getByTestId("pool-offer-yes")).toBeVisible();
    await expect(page.getByTestId("pool-offer-no")).toBeVisible();
    await expect(page.getByTestId("pool-offer-digits")).toBeVisible();
    // No sign-in link on the page: it may be forwarded (his DMs carry his own).
    await expect(page.getByTestId("pool-offer-manage")).toHaveAttribute("href", "/play/manage");
    await expect(page.locator('a[href*="/r/"]')).toHaveCount(0);
    // Not proved to be him yet (a forwarded link reads the same): no
    // distance, and his last 4 digits are asked before any answer.
    await expect(facts).not.toContainText("from you");
    await expect(page.getByTestId("pool-offer-yes")).toBeDisabled();
    await noSidewaysScroll(page);

    await page.getByTestId("pool-offer-digits").fill(await holderDigits(world, tapLinkIn(ex.sent[0])));
    await page.getByTestId("pool-offer-yes").click();
    await expect(page.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "in", { timeout: 20_000 });
    await expect(page.getByTestId("pool-offer-state")).toContainText("You're in: FNF");
    await expect(page.getByTestId("pool-offer-pull-out")).toBeVisible();
    await noSidewaysScroll(page);
  });
}

test("a link that is not ours: the page says it does not work, and offers nothing", async ({ page }) => {
  await page.goto("/play/offer/not-a-real-offer.AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "invalid");
  await expect(page.getByText("This link does not work.")).toBeVisible();
  await expect(page.getByTestId("pool-offer-yes")).toHaveCount(0);
});

test("after his yes, the organisers' match page shows him as a guest from the pool: the Guest tag and the guests panel, never his number", async ({ page, request, db }) => {
  const world = new PoolWorld(request, db, false);
  await world.start();
  const fnf = await openClub(world, "fnf-tag", { name: "FNF Tag" });
  const ali = await poolPlayer(world, "ali-tag", { name: "Ali Kaya", at: near(fnf) });
  const ex = await organiserAsks(world, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
  await pollPlatform(world, { now: at(fnf.kickoff, -8) });
  const owner = (await world.userOf(fnf.member("owner")))!;
  await page.context().clearCookies();
  await poolOpenCookie(page);
  await page.goto(tapLinkIn(ex.sent[0]));
  await page.getByTestId("pool-offer-digits").fill(await holderDigits(world, tapLinkIn(ex.sent[0])));
  await page.getByTestId("pool-offer-yes").click();
  await expect(page.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "in", { timeout: 20_000 });

  await signInAs(page, owner.id, `/matches/${fnf.group.matchId}`);
  const row = page.getByTestId("partner-guest-row");
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText("guest from MatchTime player pool");
  await expect(page.getByTestId("partner-guests-panel")).toContainText("Guests on this game");
  await expect(page.getByTestId("partner-guest-standing")).toHaveCount(0);
  await expect(page.getByTestId("guest-tag").first()).toBeVisible();
  for (const v of ali.phoneVariants()) await expect(page.locator("body")).not.toContainText(v);
});
