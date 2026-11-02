/**
 * THE PARTNER POOL INVITE'S PAGE, /play/j/<token> (2026-11-02), in a real
 * browser: who he joins as (his name, the last 4 digits of his number,
 * never the whole number), the /play form filled in from his club, one Join
 * button and no WhatsApp code; an expired or broken link, already in the
 * pool, and a stopped profile started again in place. English and Turkish.
 * No model: $0.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { PHONE, U } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";
import { partnerInviteCopy } from "@/lib/i18n/pool-partner-invite";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { partnerInviteToken } from "@/lib/pool/partner-invite-token";

process.env.AUTH_SECRET = E2E.AUTH_SECRET;
const PLAY = poolPageCopy("en");
const EN = partnerInviteCopy("en");
const TR = partnerInviteCopy("tr");
const DAY = 86_400_000;
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-partner-invite-district",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.3656, lng: -0.1963 }, location_type: "APPROXIMATE" },
      types: ["postal_code_prefix"],
      address_components: [{ short_name: "GB", types: ["country"] }],
    },
  ],
};

test.describe.configure({ mode: "serial" });
test.beforeEach(() => resetDb());
test.beforeAll(() => setGeocodeStub({ geocode: { "*": { body: UK_POINT } } }));
test.afterAll(() => {
  clearGeocodeStub();
  resetDb();
});

async function profile(db: TestDb, status: "active" | "stopped"): Promise<void> {
  await db.run(
    `INSERT INTO "PoolProfile" (id,"userId",status,"stoppedAt","consentAt","consentVersion","consentChannel","consentEvidence","adultConfirmedAt","displayName","areaDistrict","areaLat","areaLng","updatedAt")
     VALUES ('e2e-pi-profile',$1,$2,$3,now(),1,'web','e2e',now(),'Pat P','SM1',51.36,-0.19,now())`,
    [U.player, status, status === "stopped" ? new Date() : null],
  );
}

const card = (page: import("@playwright/test").Page) => page.getByTestId("partner-invite");
const tail = PHONE.player.slice(-4);

test.describe("English", () => {
  test.use({ locale: "en-GB" });

  test("a good link: who he joins as, the form filled in, no phone field; Join makes him active at once", async ({ page, db }) => {
    await page.goto(`/play/j/${partnerInviteToken(U.player, new Date())}`);
    await expect(card(page)).toHaveAttribute("data-state", "join");
    await expect(page.getByTestId("partner-invite-you")).toHaveText(EN.page_you({ name: "Pat P", tail }));
    await expect(page.getByText(EN.page_optional)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(PHONE.player.slice(1, 9));
    await expect(page.locator('input[type="tel"]')).toHaveCount(0);
    await expect(page.getByLabel(PLAY.fields.nameLabel, { exact: true })).toHaveValue("Pat P");

    await page.getByLabel(PLAY.fields.districtLabel, { exact: true }).fill("sm1");
    const tuesday = page.getByRole("checkbox", { name: "Tuesday", exact: true });
    if (!(await tuesday.isChecked())) await tuesday.check();
    const seven = page.getByRole("checkbox", { name: "7-a-side" });
    if (!(await seven.isChecked())) await seven.check();
    await page.getByRole("checkbox", { name: PLAY.signup.adultLabel }).check();
    await page.getByRole("checkbox", { name: PLAY.signup.consentLabel }).check();
    await page.getByRole("button", { name: PLAY.member.join }).click();
    await expect(card(page)).toHaveAttribute("data-state", "done");
    await expect(page.getByRole("heading", { name: EN.done_heading })).toBeVisible();

    expect(await db.one(`SELECT status, "consentEvidence" LIKE '%:partner-invite' AS marked FROM "PoolProfile" WHERE "userId" = $1`, [U.player])).toEqual({ status: "active", marked: true });
    expect(await db.count(`SELECT count(*) FROM "PlatformJob" WHERE purpose IN ('otp','pool-welcome')`)).toBe(0);
  });

  test("without the two ticks nothing is joined", async ({ page, db }) => {
    await page.goto(`/play/j/${partnerInviteToken(U.player, new Date())}`);
    await page.getByLabel(PLAY.fields.districtLabel, { exact: true }).fill("sm1");
    await page.getByRole("button", { name: PLAY.member.join }).click();
    await expect(page.getByText(PLAY.errors.consent)).toBeVisible();
    expect(await db.count(`SELECT count(*) FROM "PoolProfile" WHERE "userId" = $1`, [U.player])).toBe(0);
  });

  test("an expired link says so, names nobody, and offers the sign-up page", async ({ page }) => {
    await page.goto(`/play/j/${partnerInviteToken(U.player, new Date(Date.now() - 15 * DAY))}`);
    await expect(card(page)).toHaveAttribute("data-state", "expired");
    await expect(page.getByRole("heading", { name: EN.expired_heading })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Pat");
    await expect(page.getByRole("link", { name: EN.signup_link })).toHaveAttribute("href", "/play");
  });

  test("a link that is not ours is invalid", async ({ page }) => {
    const [, exp, sig] = partnerInviteToken(U.player, new Date()).split(".");
    await page.goto(`/play/j/${U.rater}.${exp}.${sig}`);
    await expect(card(page)).toHaveAttribute("data-state", "invalid");
    await expect(page.getByRole("heading", { name: EN.invalid_heading })).toBeVisible();
  });

  test("already in the pool: the done state, no form", async ({ page, db }) => {
    await profile(db, "active");
    await page.goto(`/play/j/${partnerInviteToken(U.player, new Date())}`);
    await expect(card(page)).toHaveAttribute("data-state", "member");
    await expect(page.getByRole("heading", { name: EN.member_heading })).toBeVisible();
    await expect(page.getByRole("button", { name: PLAY.member.join })).toHaveCount(0);
  });

  test("a stopped profile: tick the consent and start again, in place", async ({ page, db }) => {
    await profile(db, "stopped");
    await page.goto(`/play/j/${partnerInviteToken(U.player, new Date())}`);
    await expect(card(page)).toHaveAttribute("data-state", "stopped");
    await page.getByRole("button", { name: PLAY.manage.restart }).click();
    await expect(page.getByText(PLAY.errors.consent)).toBeVisible();
    await page.getByRole("checkbox", { name: PLAY.manage.restartConsent }).check();
    await page.getByRole("button", { name: PLAY.manage.restart }).click();
    await expect(card(page)).toHaveAttribute("data-state", "restarted");
    expect(await db.one(`SELECT id, status, "stoppedAt" FROM "PoolProfile" WHERE "userId" = $1`, [U.player])).toEqual({ id: "e2e-pi-profile", status: "active", stoppedAt: null });
  });
});

test.describe("Turkish", () => {
  test("his club speaks Turkish: the page opens in Turkish", async ({ page, db }) => {
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id IN (SELECT "orgId" FROM "Membership" WHERE "userId" = $1 AND "guestMatchId" IS NULL)`, [U.player]);
    await page.goto(`/play/j/${partnerInviteToken(U.player, new Date())}`);
    await expect(card(page)).toHaveAttribute("data-state", "join");
    await expect(page.getByTestId("partner-invite-you")).toHaveText(TR.page_you({ name: "Pat P", tail }));
  });
});
