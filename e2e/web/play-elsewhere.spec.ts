/**
 * "Play elsewhere too" on a club member's own /profile (local player pool,
 * slice L3), in a real browser at phone and desktop width: the form starts
 * from his club's game (pitch, Tuesday 20:00 to 21:00, 5-a-side, his short
 * name), the consent and 18+ ticks start unticked and are required, he can
 * change anything before joining, joining makes him active at once (his
 * number is on his account) with a "web" consent record, and the card then
 * links to /play/manage. A member with NO number takes the /play WhatsApp
 * step, and his own message puts the number and the profile on HIS account.
 * Turkish too. No model, Google not called (a geocoded pitch): $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import { POOL_CONSENT_VERSION } from "@/lib/pool/rules";
import { poolPageCopy } from "@/lib/pool/page-copy";

const EN = poolPageCopy("en");
const TR = poolPageCopy("tr");
const MOBILE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };
const ACTIVITY_ID = "e2e-activity";
const VENUE = { id: "e2e-elsewhere-v1", name: "Riverside Sports Centre" };

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Venue" (id, "placeId", name, "formattedAddress", lat, lng, source, "createdAt", "updatedAt")
     VALUES ($1, 'ChIJ_e2e_elsewhere_v1', $2, 'River Road, Sutton', 51.36, -0.19, 'google', now(), now()) ON CONFLICT DO NOTHING`,
    [VENUE.id, VENUE.name],
  );
  await db.run(`UPDATE "Activity" SET "venueId" = $1 WHERE id = $2`, [VENUE.id, ACTIVITY_ID]);
});

const card = (page: Page) => page.getByTestId("play-elsewhere");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const profileOf = (db: TestDb, userId: string) => db.one<Record<string, unknown>>(`SELECT * FROM "PoolProfile" WHERE "userId" = $1`, [userId]);

async function openCard(page: Page, userId: string) {
  await signInAs(page, userId, "/profile");
  await page.waitForURL("**/profile", { timeout: 30_000 });
  await expect(card(page).getByRole("heading", { name: EN.member.heading })).toBeVisible({ timeout: 30_000 });
  await card(page).getByRole("button", { name: EN.member.open }).click();
}

for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
  test(`${name}: the form starts from his club, the ticks are required, he joins and is active at once`, async ({ page, db }) => {
    await page.setViewportSize(size);
    await openCard(page, U.player);
    const c = card(page);

    // Filled in from his club: short name, the club's pitch, Tuesday's game, 5-a-side.
    await expect(c.getByText(EN.member.prefillNote)).toBeVisible();
    await expect(c.getByLabel(EN.fields.nameLabel, { exact: true })).toHaveValue("Pat P");
    await expect(c.getByRole("radio", { name: EN.fields.areaVenuesOption })).toBeChecked();
    await expect(c.getByRole("button", { name: EN.fields.venueRemove(VENUE.name) })).toBeVisible();
    await expect(c.getByRole("checkbox", { name: "Tuesday", exact: true })).toBeChecked();
    await expect(c.getByLabel(EN.fields.fromLabel("Tuesday"))).toHaveValue("20:00");
    await expect(c.getByLabel(EN.fields.toLabel("Tuesday"))).toHaveValue("21:00");
    await expect(c.getByRole("checkbox", { name: "Football", exact: true })).toBeChecked();
    await expect(c.getByRole("checkbox", { name: "5-a-side" })).toBeChecked();
    await expect(c.getByRole("radio", { name: "3 miles" })).toBeChecked();
    // Consent and 18+ start unticked; the policy is one tap away.
    await expect(c.getByRole("checkbox", { name: EN.signup.adultLabel })).not.toBeChecked();
    await expect(c.getByRole("checkbox", { name: EN.signup.consentLabel })).not.toBeChecked();
    await expect(c.getByRole("link", { name: EN.signup.consentPolicy })).toHaveAttribute("href", "/privacy");
    await expect(c.getByText(EN.member.whatsAppNote)).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // Without the ticks nothing is written.
    await c.getByRole("button", { name: EN.member.join }).click();
    await expect(c.getByText(EN.errors.adult)).toBeVisible();
    await expect(c.getByText(EN.errors.consent)).toBeVisible();
    expect(await profileOf(db, U.player)).toBeNull();

    await c.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
    await c.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
    await c.getByRole("button", { name: EN.member.join }).click();

    await expect(c.getByText(EN.member.inPool)).toBeVisible();
    await expect(c.getByTestId("play-elsewhere-status")).toHaveText(EN.manage.status.active);
    await expect(c.getByText(EN.manage.earlyNote)).toBeVisible();
    await expect(c.getByRole("link", { name: EN.member.manageLink })).toHaveAttribute("href", "/play/manage");
    await page.screenshot({ path: `test-results/play-elsewhere-${name}.png`, fullPage: true });

    expect(await profileOf(db, U.player)).toMatchObject({
      status: "active",
      displayName: "Pat P",
      venueIds: [VENUE.id],
      areaDistrict: null,
      maxMiles: 3,
      source: "profile",
      earlyList: true,
      consentChannel: "web",
      consentVersion: POOL_CONSENT_VERSION,
      confirmCode: null,
    });
    const p = await profileOf(db, U.player);
    expect(p!.consentEvidence).toMatch(new RegExp(`^web:${U.player}:\\d+:profile$`));
    expect(p!.adultConfirmedAt).not.toBeNull();
    expect(await db.all(`SELECT action, channel, phone FROM "PoolConsentRecord" WHERE "userId" = $1`, [U.player])).toEqual([
      { action: "consent", channel: "web", phone: "447700900003" },
    ]);
    // Nobody is messaged: joining from the page sends nothing.
    expect(await db.count(`SELECT count(*) FROM "PlatformJob" WHERE purpose LIKE 'pool-%'`)).toBe(0);
  });
}

test("he changes the prefilled answers before joining: what he chose is stored", async ({ page, db }) => {
  await openCard(page, U.player);
  const c = card(page);
  await c.getByLabel(EN.fields.nameLabel, { exact: true }).fill("Patrick P");
  await c.getByRole("radio", { name: "5 miles" }).check();
  await c.getByLabel(EN.fields.toLabel("Tuesday")).selectOption("22:00");
  await c.getByRole("checkbox", { name: "Thursday", exact: true }).check();
  await c.getByRole("checkbox", { name: "7-a-side" }).check();
  await c.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
  await c.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
  await c.getByRole("button", { name: EN.member.join }).click();
  await expect(c.getByText(EN.member.inPool)).toBeVisible();

  expect(await profileOf(db, U.player)).toMatchObject({ displayName: "Patrick P", maxMiles: 5 });
  const id = (await profileOf(db, U.player))!.id;
  expect(await db.all(`SELECT day, "fromMin", "toMin" FROM "PoolAvailability" WHERE "profileId" = $1 ORDER BY day`, [id])).toEqual([
    { day: 2, fromMin: 20 * 60, toMin: 22 * 60 },
    { day: 4, fromMin: 18 * 60, toMin: 22 * 60 },
  ]);
  expect(await db.all(`SELECT sport, formats FROM "PoolSport" WHERE "profileId" = $1`, [id])).toEqual([{ sport: "football", formats: [5, 7] }]);
});

test("the card links to his manage page, which shows the profile he just made", async ({ page }) => {
  await openCard(page, U.player);
  const c = card(page);
  await c.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
  await c.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
  await c.getByRole("button", { name: EN.member.join }).click();
  await c.getByRole("link", { name: EN.member.manageLink }).click();
  await page.waitForURL("**/play/manage");
  await expect(page.getByRole("heading", { level: 1, name: EN.manage.heading })).toBeVisible();
  await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.active);
  await expect(page.getByLabel(EN.fields.nameLabel, { exact: true })).toHaveValue("Pat P");
  await expect(page.getByRole("button", { name: EN.fields.venueRemove(VENUE.name) })).toBeVisible();

  // Stopped on the manage page: the card says so, and still links there.
  await page.getByRole("button", { name: EN.manage.stop }).click();
  await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.stopped);
  await page.goto("/profile");
  await expect(card(page).getByTestId("play-elsewhere-status")).toHaveText(EN.manage.status.stopped);
  await expect(card(page).getByRole("button", { name: EN.member.open })).toHaveCount(0);
});

for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
  test(`${name}: a member with no number confirms on WhatsApp, and the number and profile become HIS`, async ({ page, db, request }) => {
    await page.setViewportSize(size);
    await openCard(page, U.guest);
    const c = card(page);
    await expect(c.getByText(EN.member.whatsAppNote)).toBeVisible();
    await expect(c.getByLabel(EN.fields.nameLabel, { exact: true })).toHaveValue("Gary G");
    await c.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
    await c.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
    await c.getByRole("button", { name: EN.member.continueWhatsApp }).click();

    await expect(c.getByRole("heading", { name: EN.member.waitingHeading })).toBeVisible();
    const code = (await c.getByTestId("pool-code").innerText()).trim();
    const prefill = `Hi MatchTime, sign me up to play. Code ${code}`;
    await expect(c.getByTestId("pool-prefill")).toHaveText(prefill);
    await expect(c.getByRole("link", { name: EN.signup.openWhatsApp })).toHaveAttribute(
      "href",
      `https://wa.me/${E2E.MATCHTIME_WA_NUMBER}?text=${encodeURIComponent(prefill)}`,
    );
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await profileOf(db, U.guest)).toMatchObject({ status: "pending-verify", source: "profile", confirmCode: code });

    // Reloading keeps the waiting step (he can come back to it).
    await page.reload();
    await expect(card(page).getByTestId("pool-code")).toHaveText(code);

    const phone = `4477009${name === "phone" ? "31111" : "32222"}`;
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { phone, body: prefill, waMessageId: `e2e-elsewhere-${Date.now()}` },
    });
    expect(await res.json()).toMatchObject({ handled: "pool-confirm", result: "confirmed" });
    expect(await db.one(`SELECT "phoneNumber" FROM "User" WHERE id = $1`, [U.guest])).toEqual({ phoneNumber: `+${phone}` });
    expect(await profileOf(db, U.guest)).toMatchObject({ status: "active", consentChannel: "whatsapp", source: "profile" });
    expect(await db.count(`SELECT count(*) FROM "User" WHERE "phoneNumber" = $1`, [`+${phone}`])).toBe(1);

    await page.reload();
    await expect(card(page).getByTestId("play-elsewhere-status")).toHaveText(EN.manage.status.active);
  });
}

test.describe("in Turkish", () => {
  test.use({ locale: "tr-TR" });
  test("the card and the form read in Turkish", async ({ page }) => {
    await signInAs(page, U.player, "/profile");
    await expect(card(page).getByRole("heading", { name: TR.member.heading })).toBeVisible({ timeout: 30_000 });
    await expect(card(page).getByText(TR.member.lead)).toBeVisible();
    await card(page).getByRole("button", { name: TR.member.open }).click();
    await expect(card(page).getByText(TR.member.prefillNote)).toBeVisible();
    await expect(card(page).getByRole("checkbox", { name: TR.signup.consentLabel })).not.toBeChecked();
    await expect(card(page).getByRole("button", { name: TR.member.join })).toBeVisible();
  });
});
