/**
 * /play: the confirm screen and the reminder (2026-10-31). Two in ten
 * sign-ups never sent the WhatsApp code, and we have no number to remind
 * them. So:
 *   - the confirm screen says he is NOT in yet, with the WhatsApp button on
 *     top and how long the code works;
 *   - a returning visitor whose sign-up still waits sees the reminder above
 *     the form, with the same WhatsApp link;
 *   - once confirmed, or once the code has run out, there is no reminder and
 *     no old WhatsApp link, and the browser forgets it;
 *   - with storage blocked the sign-up still works, there is just no reminder;
 *   - the status check answers {state} and nothing else.
 * Google is a stub; no model anywhere: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { PENDING_SIGNUP_KEY } from "@/lib/pool/pending-signup";

const EN = poolPageCopy("en");
const TR = poolPageCopy("tr");
const MOBILE = { width: 390, height: 844 };
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-play-reminder",
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

async function signUp(page: Page, c = EN, name = "Ali Kaya") {
  await page.goto("/play");
  await page.getByLabel(c.fields.nameLabel, { exact: true }).fill(name);
  await page.getByLabel(c.fields.districtLabel, { exact: true }).fill("SM1");
  await page.getByRole("checkbox", { name: c.fields.dayNames[2], exact: true }).check();
  if (c === EN) await page.getByRole("checkbox", { name: "7-a-side" }).check();
  await page.getByRole("checkbox", { name: c.signup.adultLabel }).check();
  await page.getByRole("checkbox", { name: c.signup.consentLabel }).check();
  await page.getByRole("button", { name: c.signup.submit }).click();
  await expect(page.getByRole("heading", { level: 1, name: c.signup.confirmHeading })).toBeVisible();
  const code = (await page.getByTestId("pool-code").innerText()).trim();
  const waLink = await page.getByRole("link", { name: c.signup.openWhatsApp }).getAttribute("href");
  return { code, waLink: waLink! };
}

const stored = (page: Page) => page.evaluate((k) => window.localStorage.getItem(k), PENDING_SIGNUP_KEY);

test.describe("English visitor", () => {
  test.use({ locale: "en-GB" });

  test("the confirm screen: not in yet, the WhatsApp button on top, the code's 3 days", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const { code, waLink } = await signUp(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're not in yet: send the WhatsApp message");
    await expect(page.getByText(EN.signup.confirmLead)).toBeVisible();
    await expect(page.getByText(EN.signup.confirmHelp)).toBeVisible();
    expect(EN.signup.confirmHelp).toContain("3 days");
    expect(waLink).toBe(`https://wa.me/${E2E.MATCHTIME_WA_NUMBER}?text=${encodeURIComponent(`Hi MatchTime, sign me up to play. Code ${code}`)}`);
    // The button comes before the code box, and sits on a phone's first screen.
    const button = await page.getByRole("link", { name: EN.signup.openWhatsApp }).boundingBox();
    const codeBox = await page.getByTestId("pool-code").boundingBox();
    expect(button!.y).toBeLessThan(codeBox!.y);
    expect(button!.y + button!.height).toBeLessThanOrEqual(MOBILE.height * 0.6);
    // Only what the reminder needs is remembered.
    expect(Object.keys(JSON.parse((await stored(page))!)).sort()).toEqual(["code", "expiresAt", "token", "v", "waLink"]);
    await page.screenshot({ path: "test-results/play-confirm-phone.png", fullPage: true });
  });

  test("a returning visitor whose sign-up still waits sees the reminder above the form, with the same link", async ({ page }) => {
    const { code, waLink } = await signUp(page);
    await page.goto("/play");
    const reminder = page.getByTestId("pool-reminder");
    await expect(reminder).toBeVisible();
    await expect(reminder.getByRole("heading", { name: EN.signup.reminderHeading })).toBeVisible();
    await expect(reminder.getByText(EN.signup.reminderLead)).toBeVisible();
    await expect(reminder.getByRole("link", { name: EN.signup.openWhatsApp })).toHaveAttribute("href", waLink);
    await expect(reminder.getByTestId("pool-reminder-code")).toHaveText(code);
    await expect(reminder.getByTestId("pool-reminder-until")).toHaveText(/^Your code works until \w+day \d{1,2} \w+ at \d{2}:\d{2}\.$/);
    // Above the form, and the page still has one h1: the form's.
    const r = await reminder.boundingBox();
    const h1 = await page.getByRole("heading", { level: 1, name: EN.signup.heading }).boundingBox();
    expect(r!.y).toBeLessThan(h1!.y);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByLabel(EN.fields.nameLabel, { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/play-reminder.png", fullPage: true });
  });

  test("a confirmed visitor sees no reminder, and the browser forgets it", async ({ page, request }) => {
    const { code } = await signUp(page, EN, "Sam Done");
    const res = await request.post("/api/whatsapp/dm-reply", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { phone: "447700911301", body: `Hi MatchTime, sign me up to play. Code ${code}`, waMessageId: `e2e-reminder-${Date.now()}` },
    });
    expect(await res.json()).toMatchObject({ handled: "pool-confirm", result: "confirmed" });
    await page.goto("/play");
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect.poll(() => stored(page)).toBeNull();
    await expect(page.getByTestId("pool-reminder")).toHaveCount(0);
    await expect(page.getByTestId("pool-expired-note")).toHaveCount(0);
    await expect(page.getByRole("link", { name: EN.signup.openWhatsApp })).toHaveCount(0);
  });

  test("a code run out on the server: no reminder, no old link, one line to sign up again, forgotten", async ({ page, db }) => {
    const { code } = await signUp(page, EN, "Old Code");
    await db.run(`UPDATE "PoolProfile" SET "confirmCodeExpiresAt" = now() - interval '1 hour' WHERE "confirmCode" = $1`, [code]);
    await page.goto("/play");
    await expect(page.getByTestId("pool-expired-note")).toHaveText(EN.signup.expiredNote);
    await expect(page.getByTestId("pool-reminder")).toHaveCount(0);
    await expect(page.getByRole("link", { name: EN.signup.openWhatsApp })).toHaveCount(0);
    expect(await stored(page)).toBeNull();
    // Shown once: the next visit is the plain form.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect(page.getByTestId("pool-expired-note")).toHaveCount(0);
  });

  test("a code run out by the browser's own clock: no reminder and no status check at all", async ({ page }) => {
    await signUp(page, EN, "Late Lad");
    await page.evaluate((k) => {
      const v = JSON.parse(window.localStorage.getItem(k)!);
      window.localStorage.setItem(k, JSON.stringify({ ...v, expiresAt: Date.now() - 1000 }));
    }, PENDING_SIGNUP_KEY);
    const checks: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/play/signup/status")) checks.push(r.url());
    });
    await page.goto("/play");
    await expect(page.getByTestId("pool-expired-note")).toBeVisible();
    await expect(page.getByTestId("pool-reminder")).toHaveCount(0);
    await expect(page.getByRole("link", { name: EN.signup.openWhatsApp })).toHaveCount(0);
    expect(await stored(page)).toBeNull();
    expect(checks).toEqual([]);
  });

  test("with storage blocked the sign-up still works and the page shows no reminder", async ({ page }) => {
    await page.addInitScript(() => {
      for (const k of ["localStorage", "sessionStorage"]) {
        Object.defineProperty(window, k, {
          get() {
            throw new Error("blocked");
          },
        });
      }
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signUp(page, EN, "No Store");
    await page.goto("/play");
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect(page.getByTestId("pool-reminder")).toHaveCount(0);
    await expect(page.getByLabel(EN.fields.nameLabel, { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the status check answers {state} only, and a guess learns nothing", async ({ request }) => {
    for (const data of [{ token: "guess.guess", code: "ABCDE" }, { code: "ABCDE" }, {}]) {
      const res = await request.post("/api/play/signup/status", { data });
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ state: "gone" });
    }
  });
});

test.describe("Turkish visitor", () => {
  test.use({ locale: "tr-TR" });

  test("the confirm screen and the reminder in Turkish", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signUp(page, TR, "Mehmet Y");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Henüz katılmadın: WhatsApp mesajını gönder");
    await expect(page.getByText(TR.signup.confirmHelp)).toBeVisible();
    await page.goto("/play");
    const reminder = page.getByTestId("pool-reminder");
    await expect(reminder.getByRole("heading", { name: "Neredeyse bitti" })).toBeVisible();
    await expect(reminder.getByText(TR.signup.reminderLead)).toBeVisible();
    await expect(reminder.getByRole("link", { name: TR.signup.openWhatsApp })).toBeVisible();
    await expect(reminder.getByTestId("pool-reminder-until")).toHaveText(/^Kodun .+ tarihine kadar geçerli\.$/);
    await page.screenshot({ path: "test-results/play-reminder-tr.png", fullPage: true });
  });
});
