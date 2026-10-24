/**
 * /play, the local player pool's sign-up (slice L2), in a real browser:
 *   - reads at phone and desktop width, no sideways scroll, no app sidebar,
 *     one h1, every field labelled, in the browser's language with a switch;
 *   - consent and 18+ unticked by default, football ticked;
 *   - validation names every wrong field, accessibly, and sends nothing;
 *   - the full flow: fill in, continue, the wa.me link carries the prefilled
 *     message, the person sends it (the Pi's real route), the profile goes
 *     active and ONE welcome is queued to him;
 *   - the page itself never carries MatchTime's number (only the route's
 *     answer does, after a valid sign-up);
 *   - a campaign code on the URL is stamped on the profile.
 * Google is a stub; no model anywhere: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
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
      place_id: "e2e-play-district",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.3656, lng: -0.1963 }, location_type: "APPROXIMATE" },
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

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function fillValid(page: Page, name = "Ali Kaya") {
  await page.getByLabel(EN.fields.nameLabel, { exact: true }).fill(name);
  await page.getByLabel(EN.fields.districtLabel, { exact: true }).fill("sm1");
  await page.getByRole("checkbox", { name: "Tuesday", exact: true }).check();
  await page.getByLabel(EN.fields.fromLabel("Tuesday")).selectOption("19:00");
  await page.getByLabel(EN.fields.toLabel("Tuesday")).selectOption("22:00");
  await page.getByRole("checkbox", { name: "7-a-side" }).check();
  await page.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
  await page.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
}

test.describe("English visitor", () => {
  test.use({ locale: "en-GB" });

  for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
    test(`reads on ${name} width: one h1, labelled fields, safe defaults, no sideways scroll, no sidebar`, async ({ page }) => {
      await page.setViewportSize(size);
      const res = await page.goto("/play");
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator('main[lang="en"]')).toBeVisible();
      await expect(page.getByLabel(EN.fields.nameLabel, { exact: true })).toBeVisible();
      await expect(page.getByRole("group", { name: EN.fields.travelLegend })).toBeVisible();
      await expect(page.getByRole("radio", { name: "3 miles" })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "Football", exact: true })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: EN.signup.adultLabel })).not.toBeChecked();
      await expect(page.getByRole("checkbox", { name: EN.signup.consentLabel })).not.toBeChecked();
      await expect(page.getByRole("link", { name: EN.signup.consentPolicy })).toHaveAttribute("href", "/privacy");
      // Formats only where the sport has them: tennis has none.
      await page.getByRole("checkbox", { name: "Tennis", exact: true }).check();
      await expect(page.getByRole("group", { name: EN.fields.formatsLegend("Tennis") })).toHaveCount(0);
      await expect(page.getByRole("group", { name: EN.fields.formatsLegend("Football") })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("link", { name: /^matches$/i })).toHaveCount(0);
      await page.screenshot({ path: `test-results/play-${name}.png`, fullPage: true });
    });
  }

  test("the page never carries MatchTime's number", async ({ page, request }) => {
    const html = await (await request.get("/play")).text();
    for (const v of [E2E.MATCHTIME_WA_NUMBER, `+${E2E.MATCHTIME_WA_NUMBER}`, "07700900555", "07700 900555"]) expect(html).not.toContain(v);
    await page.goto("/play");
    expect(await page.content()).not.toContain(E2E.MATCHTIME_WA_NUMBER);
  });

  test("submitting empty names every wrong field, accessibly, and writes nothing", async ({ page, db }) => {
    const before = await db.count(`SELECT count(*) FROM "PoolProfile"`);
    await page.goto("/play");
    await page.getByRole("button", { name: EN.signup.submit }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText(EN.errorSummary);
    await expect(page.getByText(EN.errors.name)).toBeVisible();
    await expect(page.getByText(EN.errors["area-district"])).toBeVisible();
    await expect(page.getByText(EN.errors["availability-none"])).toBeVisible();
    await expect(page.getByText(EN.errors.adult)).toBeVisible();
    await expect(page.getByText(EN.errors.consent)).toBeVisible();
    await expect(page.getByLabel(EN.fields.nameLabel, { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(await db.count(`SELECT count(*) FROM "PoolProfile"`)).toBe(before);
  });

  test("a time that ends before it starts is refused next to the days", async ({ page }) => {
    await page.goto("/play");
    await fillValid(page);
    await page.getByLabel(EN.fields.fromLabel("Tuesday")).selectOption("22:00");
    await page.getByLabel(EN.fields.toLabel("Tuesday")).selectOption("19:00");
    await page.getByRole("button", { name: EN.signup.submit }).click();
    await expect(page.getByText(EN.errors["availability-bad-range"])).toBeVisible();
  });

  test("the full flow: fill in, open WhatsApp, send the message, the profile is live and he is welcomed once", async ({ page, db, request }) => {
    await page.goto("/play?c=li-kemal");
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ('li-kemal', 'linkedin', 'post') ON CONFLICT DO NOTHING`);
    await fillValid(page);
    await page.getByRole("checkbox", { name: "Saturday", exact: true }).check();
    await page.getByRole("button", { name: EN.fields.addRange("Saturday") }).click();
    await page.getByRole("button", { name: EN.signup.submit }).click();

    await expect(page.getByRole("heading", { level: 1, name: EN.signup.confirmHeading })).toBeVisible();
    const code = (await page.getByTestId("pool-code").innerText()).trim();
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    const prefill = `Hi MatchTime, sign me up to play. Code ${code}`;
    await expect(page.getByTestId("pool-prefill")).toHaveText(prefill);
    await expect(page.getByRole("link", { name: EN.signup.openWhatsApp })).toHaveAttribute(
      "href",
      `https://wa.me/${E2E.MATCHTIME_WA_NUMBER}?text=${encodeURIComponent(prefill)}`,
    );
    await expect(page.getByText(EN.signup.confirmEarly)).toBeVisible();

    const row = await db.one<{ status: string; source: string; sourceCode: string; maxMiles: number }>(
      `SELECT status, source, "sourceCode", "maxMiles" FROM "PoolProfile" WHERE "confirmCode" = $1`,
      [code],
    );
    expect(row).toMatchObject({ status: "pending-verify", source: "campaign", sourceCode: "li-kemal", maxMiles: 3 });
    const ranges = await db.all<{ day: number; fromMin: number; toMin: number }>(
      `SELECT a.day, a."fromMin", a."toMin" FROM "PoolAvailability" a JOIN "PoolProfile" p ON p.id = a."profileId" WHERE p."confirmCode" = $1 ORDER BY a.day, a."fromMin"`,
      [code],
    );
    expect(ranges).toEqual([
      { day: 2, fromMin: 19 * 60, toMin: 22 * 60 },
      { day: 6, fromMin: 18 * 60, toMin: 24 * 60 },
    ]);

    // He sends it from his own WhatsApp: the Pi forwards it to the real route.
    const phone = "447700911234";
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { phone, body: prefill, waMessageId: `e2e-play-${Date.now()}` },
    });
    expect(await res.json()).toMatchObject({ handled: "pool-confirm", result: "confirmed" });
    const live = await db.one<{ status: string; consentChannel: string }>(
      `SELECT p.status, p."consentChannel" FROM "PoolProfile" p JOIN "User" u ON u.id = p."userId" WHERE u."phoneNumber" = $1`,
      [`+${phone}`],
    );
    expect(live).toMatchObject({ status: "active", consentChannel: "whatsapp" });
    expect(await db.count(`SELECT count(*) FROM "PlatformJob" WHERE purpose = 'pool-welcome' AND phone = $1`, [phone])).toBe(1);
  });

  test("chosen pitches instead of a postcode area: search MatchTime's pitches and pick one", async ({ page, db }) => {
    await db.run(
      `INSERT INTO "Venue" (id, "placeId", name, "formattedAddress", lat, lng, source, "createdAt", "updatedAt") VALUES ('e2e-play-v1', 'ChIJ_e2e_play_v1', 'Riverside Sports Centre', 'River Road, Sutton', 51.36, -0.19, 'google', now(), now()) ON CONFLICT DO NOTHING`,
    );
    await page.goto("/play");
    await fillValid(page, "Sam S");
    await page.getByRole("radio", { name: EN.fields.areaVenuesOption }).check();
    await page.getByLabel(EN.fields.venueSearchLabel).fill("Riverside");
    await page.getByRole("button", { name: EN.fields.venueAdd("Riverside Sports Centre") }).click();
    await expect(page.getByRole("button", { name: EN.fields.venueRemove("Riverside Sports Centre") })).toBeVisible();
    await page.getByRole("button", { name: EN.signup.submit }).click();
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.confirmHeading })).toBeVisible();
    const code = (await page.getByTestId("pool-code").innerText()).trim();
    expect(await db.one(`SELECT "venueIds", "areaDistrict" FROM "PoolProfile" WHERE "confirmCode" = $1`, [code])).toEqual({
      venueIds: ["e2e-play-v1"],
      areaDistrict: null,
    });
  });
});

test.describe("Turkish visitor", () => {
  test.use({ locale: "tr-TR" });

  test("opens in Turkish, switches to English and back, and the prefill follows the language", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto("/play");
    await expect(page.getByRole("heading", { level: 1, name: TR.signup.heading })).toBeVisible();
    await expect(page.locator('main[lang="tr"]')).toBeVisible();
    await page.getByRole("button", { name: "English" }).click();
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await page.getByRole("button", { name: "Türkçe" }).click();
    await expect(page.getByRole("button", { name: "Türkçe" })).toHaveAttribute("aria-pressed", "true");

    await page.getByLabel(TR.fields.nameLabel, { exact: true }).fill("Mehmet Y");
    await page.getByLabel(TR.fields.districtLabel, { exact: true }).fill("SW19");
    await page.getByRole("checkbox", { name: "Cuma", exact: true }).check();
    await page.getByRole("checkbox", { name: TR.signup.adultLabel }).check();
    await page.getByRole("checkbox", { name: TR.signup.consentLabel }).check();
    await page.getByRole("button", { name: TR.signup.submit }).click();
    await expect(page.getByRole("heading", { level: 1, name: TR.signup.confirmHeading })).toBeVisible();
    await expect(page.getByTestId("pool-prefill")).toHaveText(/^Merhaba MatchTime, oynamak için kaydet\. Kod [A-Z2-9]{5}$/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
