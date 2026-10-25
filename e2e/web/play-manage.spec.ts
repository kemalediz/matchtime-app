/**
 * /play/manage, the player pool profile's own page (slice L2), in a real
 * browser, at phone and desktop width: opens in the profile's language,
 * pause and resume, stop and start again (a fresh consent), edit what the
 * sign-up asked, the badge privacy switch, delete. Signed out it asks for
 * sign-in; a signed-in person with no profile is pointed at /play.
 * The profiles are made the real way: the /play route, then the person's
 * own WhatsApp message through the Pi's route. Google is a stub; no model: $0.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";
import { poolPageCopy } from "@/lib/pool/page-copy";

const EN = poolPageCopy("en");
const TR = poolPageCopy("tr");
const MOBILE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-manage-district",
      formatted_address: "UK",
      geometry: { location: { lat: 51.4, lng: -0.2 }, location_type: "APPROXIMATE" },
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
test.afterAll(() => clearGeocodeStub());

let seq = 0;
/** A confirmed pool player, made through the real routes. Returns his user id. */
async function poolPlayer(request: APIRequestContext, db: TestDb, opts: { name?: string; language?: "en" | "tr" } = {}): Promise<{ userId: string; phone: string }> {
  const signup = await request.post("/api/play/signup", {
    data: {
      name: opts.name ?? "Ali Kaya",
      area: { kind: "district", district: "SM1" },
      maxMiles: 3,
      availability: [{ day: 2, from: "19:00", to: "22:00" }],
      sports: [{ sport: "football", formats: [7] }],
      language: opts.language ?? "en",
      adult: true,
      consent: true,
    },
  });
  const { prefill } = (await signup.json()) as { prefill: string };
  const phone = `4477009${String(20000 + ++seq).padStart(5, "0")}`;
  const dm = await request.post("/api/whatsapp/dm-reply", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { phone, body: prefill, waMessageId: `e2e-manage-${Date.now()}-${seq}` },
  });
  expect(await dm.json()).toMatchObject({ result: "confirmed" });
  const u = await db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [`+${phone}`]);
  return { userId: u!.id, phone };
}

const profile = (db: TestDb, userId: string) => db.one<Record<string, unknown>>(`SELECT * FROM "PoolProfile" WHERE "userId" = $1`, [userId]);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
  test(`reads on ${name} width with his details filled in, one h1, no sideways scroll, no sidebar`, async ({ page, request, db }) => {
    const { userId } = await poolPlayer(request, db);
    await page.setViewportSize(size);
    await signInAs(page, userId, "/play/manage");
    await expect(page.getByRole("heading", { level: 1, name: EN.manage.heading })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.active);
    await expect(page.getByText(EN.manage.earlyNote)).toBeVisible();
    await expect(page.getByLabel(EN.fields.nameLabel, { exact: true })).toHaveValue("Ali Kaya");
    await expect(page.getByLabel(EN.fields.districtLabel, { exact: true })).toHaveValue("SM1");
    await expect(page.getByRole("checkbox", { name: "Tuesday", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "7-a-side" })).toBeChecked();
    await expect(page.getByRole("switch", { name: EN.manage.showRecognitionLabel })).toBeChecked();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: /^matches$/i })).toHaveCount(0);
    await page.screenshot({ path: `test-results/play-manage-${name}.png`, fullPage: true });
  });
}

test("pause, resume, stop, and start again with a fresh web consent", async ({ page, request, db }) => {
  const { userId } = await poolPlayer(request, db);
  await signInAs(page, userId, "/play/manage");

  await page.getByRole("button", { name: EN.manage.pause }).click();
  await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.paused);
  expect(await profile(db, userId)).toMatchObject({ status: "paused", pausedReason: "self" });

  await page.getByRole("button", { name: EN.manage.resume }).click();
  await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.active);

  await page.getByRole("button", { name: EN.manage.stop }).click();
  await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.stopped);
  expect(await profile(db, userId)).toMatchObject({ status: "stopped" });

  // Start again needs the consent ticked.
  await page.getByRole("button", { name: EN.manage.restart }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText(EN.errors.consent);
  expect(await profile(db, userId)).toMatchObject({ status: "stopped" });
  await page.getByRole("checkbox", { name: EN.manage.restartConsent }).check();
  await page.getByRole("button", { name: EN.manage.restart }).click();
  await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.active);
  const p = await profile(db, userId);
  expect(p).toMatchObject({ status: "active", consentChannel: "web" });
  expect(String(p!.consentEvidence)).toMatch(new RegExp(`^web:${userId}:\\d+$`));
  expect(await db.all(`SELECT action, channel FROM "PoolConsentRecord" WHERE "userId" = $1 ORDER BY "createdAt", id`, [userId])).toEqual([
    { action: "consent", channel: "whatsapp" },
    { action: "withdraw", channel: "web" },
    { action: "consent", channel: "web" },
  ]);
});

test("a pause MatchTime decided cannot be lifted from the page", async ({ page, request, db }) => {
  const { userId } = await poolPlayer(request, db);
  await db.run(`UPDATE "PoolProfile" SET status = 'paused', "pausedReason" = 'no-shows', "pausedAt" = now() WHERE "userId" = $1`, [userId]);
  await signInAs(page, userId, "/play/manage");
  await expect(page.getByTestId("pool-status")).toHaveText(EN.manage.status.pausedByMatchTime);
  await expect(page.getByRole("button", { name: EN.manage.resume })).toHaveCount(0);
  await expect(page.getByRole("button", { name: EN.manage.stop })).toBeVisible();
});

test("edit everything the sign-up asked: saved to the profile, wrong answers named", async ({ page, request, db }) => {
  const { userId } = await poolPlayer(request, db);
  await signInAs(page, userId, "/play/manage");

  await page.getByLabel(EN.fields.districtLabel, { exact: true }).fill("12");
  await page.getByRole("button", { name: EN.manage.save }).click();
  await expect(page.getByText(EN.errors["area-district"])).toBeVisible();

  await page.getByLabel(EN.fields.nameLabel, { exact: true }).fill("Ali K");
  await page.getByLabel(EN.fields.districtLabel, { exact: true }).fill("SW19");
  await page.getByRole("radio", { name: "10 miles" }).check();
  await page.getByRole("checkbox", { name: "Saturday", exact: true }).check();
  // Football is the only sport offered (LIVE_SPORTS): no sport to tick, only its formats and level.
  await expect(page.getByRole("checkbox", { name: "Football", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "5-a-side" }).check();
  await page.getByLabel(EN.fields.levelLabel("Football")).selectOption("own");
  await page.getByLabel(EN.fields.levelOwnWordsLabel("Football")).fill("keen beginner");
  await page.getByLabel(EN.fields.languageLabel).selectOption("tr");
  await page.getByRole("button", { name: EN.manage.save }).click();
  await expect(page.locator("main").getByRole("status")).toHaveText(EN.manage.saved);

  expect(await profile(db, userId)).toMatchObject({ displayName: "Ali K", areaDistrict: "SW19", maxMiles: 10, language: "tr" });
  const sports = await db.all(
    `SELECT s.sport, s."levelText", s.formats FROM "PoolSport" s JOIN "PoolProfile" p ON p.id = s."profileId" WHERE p."userId" = $1 ORDER BY s.sport`,
    [userId],
  );
  expect(sports).toEqual([{ sport: "football", levelText: "keen beginner", formats: [5, 7] }]);
  expect(await db.count(`SELECT count(*) FROM "PoolAvailability" a JOIN "PoolProfile" p ON p.id = a."profileId" WHERE p."userId" = $1`, [userId])).toBe(2);
});

test("a saved sport that is no longer offered is shown and kept when he saves; no other sport is offered", async ({ page, request, db }) => {
  const { userId } = await poolPlayer(request, db);
  // Prod has none today; a padel row from before football-only (LIVE_SPORTS).
  await db.run(
    `INSERT INTO "PoolSport" (id, "profileId", sport, "otherName", level, formats) SELECT 'e2e-manage-padel', id, 'padel', '', 'novice', '{}' FROM "PoolProfile" WHERE "userId" = $1`,
    [userId],
  );
  await signInAs(page, userId, "/play/manage");
  const sports = page.getByTestId("pool-sports");
  await expect(sports.getByRole("checkbox", { name: "Padel", exact: true })).toBeChecked();
  await expect(sports.getByRole("checkbox", { name: "Football", exact: true })).toBeChecked();
  for (const other of ["Basketball", "Tennis", "Badminton", "Squash", "Table tennis", "Snooker", "Billiards", "Other"]) {
    await expect(sports.getByText(other, { exact: true })).toHaveCount(0);
  }
  await page.getByRole("radio", { name: "10 miles" }).check();
  await page.getByRole("button", { name: EN.manage.save }).click();
  await expect(page.locator("main").getByRole("status")).toHaveText(EN.manage.saved);
  expect(await db.all(`SELECT s.sport, s.level FROM "PoolSport" s JOIN "PoolProfile" p ON p.id = s."profileId" WHERE p."userId" = $1 ORDER BY s.sport`, [userId])).toEqual([
    { sport: "football", level: null },
    { sport: "padel", level: "novice" },
  ]);
});

test("the badge privacy switch", async ({ page, request, db }) => {
  const { userId } = await poolPlayer(request, db);
  await signInAs(page, userId, "/play/manage");
  await page.getByRole("switch", { name: EN.manage.showRecognitionLabel }).uncheck();
  await expect.poll(async () => (await profile(db, userId))?.showRecognition).toBe(false);
  await page.reload();
  await expect(page.getByRole("switch", { name: EN.manage.showRecognitionLabel })).not.toBeChecked();
});

test("delete asks twice, then erases a pool-only person whole", async ({ page, request, db }) => {
  const { userId } = await poolPlayer(request, db);
  await signInAs(page, userId, "/play/manage");
  await page.getByRole("button", { name: EN.manage.deleteButton }).click();
  await page.getByRole("button", { name: EN.manage.deleteCancel }).click();
  expect(await profile(db, userId)).not.toBeNull();
  await page.getByRole("button", { name: EN.manage.deleteButton }).click();
  await page.getByRole("button", { name: EN.manage.deleteConfirm }).click();
  await expect(page.getByRole("heading", { level: 1, name: EN.manage.deletedHeading })).toBeVisible();
  expect(await profile(db, userId)).toBeNull();
  expect(await db.one(`SELECT id FROM "User" WHERE id = $1`, [userId])).toBeNull();
});

test("a Turkish profile opens in Turkish", async ({ page, request, db }) => {
  const { userId } = await poolPlayer(request, db, { name: "Mehmet Y", language: "tr" });
  await page.setViewportSize(MOBILE);
  await signInAs(page, userId, "/play/manage");
  await expect(page.getByRole("heading", { level: 1, name: TR.manage.heading })).toBeVisible();
  await expect(page.locator('main[lang="tr"]')).toBeVisible();
  await expect(page.getByTestId("pool-status")).toHaveText(TR.manage.status.active);
});

test("signed out, the page asks for sign-in; signed in with no profile, it points at /play", async ({ page }) => {
  await page.goto("/play/manage");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fplay%2Fmanage/);
  await signInAs(page, U.player, "/play/manage");
  await expect(page.getByText(EN.manage.noProfile)).toBeVisible();
  await expect(page.getByRole("link", { name: EN.manage.signUpLink })).toHaveAttribute("href", "/play");
});
