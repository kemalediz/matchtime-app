/**
 * /play, THE SHORT FORM (Kemal, 2026-11-04), on a phone, end to end:
 *   - three answers (name, postcode area, days), the 18+ tick and the
 *     WhatsApp consent tick with the privacy link, and Continue to WhatsApp;
 *     nothing else on the page, no sideways scroll at 390px;
 *   - the sign-up is stored with the defaults (3 miles, each day whole,
 *     football in any format, no level);
 *   - he sends the WhatsApp message: the welcome asks his times and formats;
 *   - he answers in his own words (the reader STUBBED: what the model would
 *     have said), through the real DM route: his profile changes and he is
 *     told what was saved;
 *   - a reply that ignores the question changes nothing and gets nothing.
 * Google is a stub, the reader is a stub: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";
import { clearPoolReplyStub, setPoolReplyStub } from "../helpers/stub";
import { poolPageCopy } from "@/lib/pool/page-copy";

const EN = poolPageCopy("en");
const PHONE = { width: 390, height: 844 };
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-play-short",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.3656, lng: -0.1963 }, location_type: "APPROXIMATE" },
      types: ["postal_code_prefix"],
      address_components: [{ short_name: "GB", types: ["country"] }],
    },
  ],
};
const ANSWER = "weekday evenings after 7, 5 or 7 a side";
const IGNORED = "cool, cheers";

test.describe.configure({ mode: "serial" });
test.use({ locale: "en-GB" });
test.beforeAll(() => {
  resetDb();
  setGeocodeStub({ geocode: { "*": { body: UK_POINT } } });
  setPoolReplyStub({
    bodies: {
      [ANSWER]: `details:${JSON.stringify({ hours: [{ day: 2, from: "19:00", to: "24:00" }], formats: [5, 7] })}`,
      [IGNORED]: "neither",
    },
  });
});
test.afterAll(() => {
  clearGeocodeStub();
  clearPoolReplyStub();
});

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const dm = (request: import("@playwright/test").APIRequestContext, phone: string, body: string) =>
  request.post("/api/whatsapp/dm-reply", { headers: { "x-api-key": E2E.WHATSAPP_API_KEY }, data: { phone, body, waMessageId: `e2e-short-${Date.now()}-${Math.random()}` } });

test("on a phone: three answers, the two legal ticks, Continue to WhatsApp, and nothing else", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/play");
  const fields = page.getByTestId("pool-short-fields");
  await expect(fields.getByRole("textbox")).toHaveCount(2);
  await expect(page.getByLabel(EN.fields.nameLabel, { exact: true })).toBeVisible();
  await expect(page.getByLabel(EN.fields.districtLabel, { exact: true })).toBeVisible();
  const days = page.getByRole("group", { name: EN.signup.daysLegend });
  await expect(days.getByRole("checkbox")).toHaveCount(7);
  await expect(page.getByText(EN.signup.daysHint)).toBeVisible();
  // Every checkbox on the page: seven days and the two ticks.
  await expect(page.getByRole("checkbox")).toHaveCount(9);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: EN.signup.adultLabel })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: EN.signup.consentLabel })).not.toBeChecked();
  await expect(page.getByRole("link", { name: EN.signup.consentPolicy })).toHaveAttribute("href", "/privacy");
  await expect(page.getByRole("button", { name: EN.signup.submit })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // A day is a comfortable tap target on a phone.
  const tue = await days.locator("label", { hasText: "Tuesday" }).boundingBox();
  expect(tue!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "test-results/play-short-phone.png", fullPage: true });
});

test("nothing ticked: the name, area, days and both ticks are named, and nothing is written", async ({ page, db }) => {
  await page.setViewportSize(PHONE);
  const before = await db.count(`SELECT count(*) FROM "PoolProfile"`);
  await page.goto("/play");
  await page.getByRole("button", { name: EN.signup.submit }).click();
  await expect(page.getByText(EN.errors.name)).toBeVisible();
  await expect(page.getByText(EN.errors["area-district"])).toBeVisible();
  await expect(page.getByText(EN.signup.daysNone)).toBeVisible();
  await expect(page.getByText(EN.errors.adult)).toBeVisible();
  await expect(page.getByText(EN.errors.consent)).toBeVisible();
  await expect(page.getByRole("group", { name: EN.signup.daysLegend })).toHaveAttribute("aria-invalid", "true");
  expect(await db.count(`SELECT count(*) FROM "PoolProfile"`)).toBe(before);
});

test("the whole path: sign up on a phone, confirm on WhatsApp, answer the times question in his own words", async ({ page, db, request }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/play");
  await page.getByLabel(EN.fields.nameLabel, { exact: true }).fill("Sam Short");
  await page.getByLabel(EN.fields.districtLabel, { exact: true }).fill("sm1");
  await page.getByRole("checkbox", { name: "Tuesday", exact: true }).check();
  await page.getByRole("checkbox", { name: "Saturday", exact: true }).check();
  await page.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
  await page.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
  await page.getByRole("button", { name: EN.signup.submit }).click();
  await expect(page.getByRole("heading", { level: 1, name: EN.signup.confirmHeading })).toBeVisible();
  const code = (await page.getByTestId("pool-code").innerText()).trim();
  const prefill = (await page.getByTestId("pool-prefill").innerText()).trim();

  // The defaults.
  const p = (await db.one<{ id: string; maxMiles: number }>(`SELECT id, "maxMiles" FROM "PoolProfile" WHERE "confirmCode" = $1`, [code]))!;
  expect(p.maxMiles).toBe(3);
  expect(await db.all(`SELECT day, "fromMin", "toMin" FROM "PoolAvailability" WHERE "profileId" = $1 ORDER BY day`, [p.id])).toEqual([
    { day: 2, fromMin: 0, toMin: 1440 },
    { day: 6, fromMin: 0, toMin: 1440 },
  ]);
  expect(await db.all(`SELECT sport, formats, level FROM "PoolSport" WHERE "profileId" = $1`, [p.id])).toEqual([{ sport: "football", formats: [], level: null }]);

  // He sends the message: the welcome asks his times and formats.
  const phone = "447700911777";
  expect(await (await dm(request, phone, prefill)).json()).toMatchObject({ handled: "pool-confirm", result: "confirmed" });
  const welcome = (await db.one<{ text: string }>(`SELECT text FROM "PlatformJob" WHERE purpose = 'pool-welcome' AND phone = $1`, [phone]))!;
  expect(welcome.text).toContain("what times can you play on Tuesday and Saturday? And which formats do you play: 5, 7, 8, 9 or 11-a-side?");

  // A reply that ignores the question: nothing changes, nothing is said.
  const jobs = () => db.count(`SELECT count(*) FROM "PlatformJob" WHERE phone = $1`, [phone]);
  const before = await jobs();
  const ignored = await (await dm(request, phone, IGNORED)).json();
  expect(ignored.handled).toBeUndefined();
  expect(await jobs()).toBe(before);

  // His answer, in his own words: saved, and he is told what.
  expect(await (await dm(request, phone, ANSWER)).json()).toMatchObject({ handled: "pool-details-saved" });
  expect(await db.all(`SELECT day, "fromMin", "toMin" FROM "PoolAvailability" WHERE "profileId" = $1 ORDER BY day`, [p.id])).toEqual([
    { day: 2, fromMin: 19 * 60, toMin: 1440 },
    { day: 6, fromMin: 0, toMin: 1440 },
  ]);
  expect(await db.all(`SELECT formats FROM "PoolSport" WHERE "profileId" = $1`, [p.id])).toEqual([{ formats: [5, 7] }]);
  const saved = (await db.one<{ text: string }>(`SELECT text FROM "PlatformJob" WHERE purpose = 'pool-reply' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`, [phone]))!;
  expect(saved.text).toMatch(/^✅ Got it, saved: Tuesday from 19:00 and Saturday any time\. Formats: 5 and 7-a-side\./);
  // Answered: he is never asked again.
  expect(await db.count(`SELECT count(*) FROM "SentNotification" WHERE key = $1`, [`pool-details:${p.id}:answered`])).toBe(1);
});
