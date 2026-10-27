/**
 * /play: the sign-up keeps what he typed, and the page is short (Kemal,
 * 2026-10-27). He opened the privacy policy from the form, pressed "Back to
 * MatchTime", landed on the home page and lost every answer. So:
 *   - the form's links to the privacy policy open a new tab, never leave the form;
 *   - the policy's back control returns an in-site reader to where he came from
 *     (history back, or closes the tab the form opened), else goes home;
 *   - the form keeps an unsent draft in this tab (sessionStorage) across a reload
 *     or a back navigation, and forgets it once the sign-up is sent;
 *   - the name field is near the top of a phone's first screen (390x844): its
 *     box ends in the top 60%, so he sees it at a glance with its hint.
 * Set MT_SHOT_PATH to save the first screen as a screenshot. Google is a stub;
 * no model anywhere: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { privacyPolicy } from "@/lib/i18n/privacy-policy";
import { SIGNUP_DRAFT_KEY } from "@/lib/pool/signup-draft";

const EN = poolPageCopy("en");
const POLICY = privacyPolicy("en");
const MOBILE = { width: 390, height: 844 };
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-play-draft",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.3656, lng: -0.1963 }, location_type: "APPROXIMATE" },
      types: ["postal_code_prefix"],
      address_components: [{ short_name: "GB", types: ["country"] }],
    },
  ],
};

test.use({ locale: "en-GB" });
test.beforeAll(() => {
  resetDb();
  setGeocodeStub({ geocode: { "*": { body: UK_POINT } } });
});
test.afterAll(() => clearGeocodeStub());

const name = (page: Page) => page.getByLabel(EN.fields.nameLabel, { exact: true });
const district = (page: Page) => page.getByLabel(EN.fields.districtLabel, { exact: true });

async function fillSome(page: Page) {
  await name(page).fill("Kemal E");
  await district(page).fill("SM1");
  await page.getByRole("checkbox", { name: "Tuesday", exact: true }).check();
  await page.getByLabel(EN.fields.toLabel("Tuesday")).selectOption("22:00");
  await page.getByRole("checkbox", { name: "7-a-side" }).check();
}

async function expectFilled(page: Page) {
  await expect(name(page)).toHaveValue("Kemal E");
  await expect(district(page)).toHaveValue("SM1");
  await expect(page.getByRole("checkbox", { name: "Tuesday", exact: true })).toBeChecked();
  await expect(page.getByLabel(EN.fields.toLabel("Tuesday"))).toHaveValue("22:00");
  await expect(page.getByRole("checkbox", { name: "7-a-side" })).toBeChecked();
}

test("the name field is on a phone's first screen", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/play?src=site-hero");
  await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
  await page.waitForLoadState("networkidle");
  if (process.env.MT_SHOT_PATH) await page.screenshot({ path: process.env.MT_SHOT_PATH });
  const box = await name(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(MOBILE.height * 0.6);
});

test("Kemal's path: fill in, open the privacy policy, press its back control, and every answer is still there", async ({ page, context }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/play?src=site-hero");
  await fillSome(page);

  const policyLink = page.getByRole("link", { name: EN.signup.consentPolicy });
  await expect(policyLink).toHaveAttribute("target", "_blank");
  await expect(policyLink).toHaveAttribute("rel", /noopener/);

  const opened = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
  await policyLink.click();
  const policy = (await opened) ?? page;
  await expect(policy.getByRole("heading", { level: 1, name: POLICY.title })).toBeVisible();
  await policy.getByRole("link", { name: POLICY.backHome }).click();

  // The tab the form opened closes (or comes back to /play); the form's own tab never moved.
  if (policy !== page) {
    await expect.poll(() => policy.isClosed() || new URL(policy.url()).pathname === "/play").toBe(true);
  }
  await expect(page).toHaveURL(/\/play/);
  await expectFilled(page);
});

test("every privacy link on the sign-up page opens in a new tab", async ({ page }) => {
  await page.goto("/play");
  const links = page.locator('a[href="/privacy"]');
  expect(await links.count()).toBeGreaterThanOrEqual(2);
  for (const l of await links.all()) {
    await expect(l).toHaveAttribute("target", "_blank");
    await expect(l).toHaveAttribute("rel", /noopener/);
  }
});

test("arriving at the policy from inside the site in the same tab, the back control goes back to the form, draft kept", async ({ page }) => {
  await page.goto("/play");
  await fillSome(page);
  await page.evaluate(() => window.location.assign("/privacy"));
  await expect(page.getByRole("heading", { level: 1, name: POLICY.title })).toBeVisible();
  await page.getByRole("link", { name: POLICY.backHome }).click();
  await expect(page).toHaveURL(/\/play$/);
  // The draft survived the trip. (The fields themselves are checked after a
  // reload: `next dev` never re-hydrates a page reached by back or forward,
  // on any page and on main too, while a production build does. Checked by
  // hand against `next start` on 2026-10-27: there the fields come back
  // filled on this exact path.)
  const draft = await page.evaluate((k) => window.sessionStorage.getItem(k), SIGNUP_DRAFT_KEY);
  expect(JSON.parse(draft ?? "{}").form?.name).toBe("Kemal E");
  await page.reload();
  await expectFilled(page);
});

test("arriving at the policy from outside, the back control goes home", async ({ page }) => {
  await page.goto("/privacy");
  await page.getByRole("link", { name: POLICY.backHome }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("a reload keeps the draft; the two ticks are never kept; a sent sign-up forgets it", async ({ page }) => {
  await page.goto("/play");
  await fillSome(page);
  await page.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
  await page.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
  await page.reload();
  await expectFilled(page);
  await expect(page.getByRole("checkbox", { name: EN.signup.adultLabel })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: EN.signup.consentLabel })).not.toBeChecked();

  await page.getByRole("checkbox", { name: EN.signup.adultLabel }).check();
  await page.getByRole("checkbox", { name: EN.signup.consentLabel }).check();
  await page.getByRole("button", { name: EN.signup.submit }).click();
  await expect(page.getByRole("heading", { level: 1, name: EN.signup.confirmHeading })).toBeVisible();
  expect(await page.evaluate((k) => window.sessionStorage.getItem(k), SIGNUP_DRAFT_KEY)).toBeNull();
  await page.goto("/play");
  await expect(name(page)).toHaveValue("");
});

test("with storage blocked the form still works, it just keeps nothing", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  });
  await page.goto("/play");
  await fillSome(page);
  await expectFilled(page);
});
