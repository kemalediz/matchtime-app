/**
 * THE FRIEND LINK'S PAGE, /play/f/<token> (2026-10-31), in a real browser:
 * the /play form with the match at the top (who invited him, the club, the
 * day and time, the venue, the fee), his name filled in when the member
 * gave it, no phone field; a used, started, called-off or unknown link says
 * so and offers the plain pool sign-up. English and Turkish. No model: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { MATCH, ORG_ID, U } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";
import { friendLinkCopy } from "@/lib/i18n/friend-link";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { friendLinkToken } from "@/lib/friend-link/token";
import { clearGeocodeStub, setGeocodeStub } from "../helpers/geocode-stub";

const PLAY = poolPageCopy("en");
const UK_POINT = {
  status: "OK",
  results: [
    {
      place_id: "e2e-friend-district",
      formatted_address: "Sutton SM1, UK",
      geometry: { location: { lat: 51.3656, lng: -0.1963 }, location_type: "APPROXIMATE" },
      types: ["postal_code_prefix"],
      address_components: [{ short_name: "GB", types: ["country"] }],
    },
  ],
};

process.env.AUTH_SECRET = E2E.AUTH_SECRET;
const EN = friendLinkCopy("en");
const TR = friendLinkCopy("tr");

test.describe.configure({ mode: "serial" });
test.beforeEach(() => resetDb());
test.beforeAll(() => setGeocodeStub({ geocode: { "*": { body: UK_POINT } } }));
test.afterAll(() => {
  clearGeocodeStub();
  resetDb();
});

let seq = 0;
async function seedLink(db: TestDb, over: { friendName?: string | null; used?: boolean } = {}): Promise<string> {
  const id = `e2efriendlink${++seq}${Date.now().toString(36)}`;
  await db.run(
    `INSERT INTO "FriendLink" (id, "orgId", "matchId", "issuedByUserId", "friendName", "sourceMessageId", "updatedAt", "usedAt", "usedMessageId", outcome)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9)`,
    [id, ORG_ID, MATCH.upcoming, U.player, over.friendName === undefined ? "Ali" : over.friendName, `wamid.${id}`, over.used ? new Date() : null, over.used ? `wamid.used.${id}` : null, over.used ? "in" : null],
  );
  return friendLinkToken(id);
}

const card = (page: Page) => page.getByTestId("friend-link-card");

test.describe("English", () => {
  test.use({ locale: "en-GB" });

  test("an open link: the match card, his name filled in, no phone field", async ({ page, db }) => {
    const token = await seedLink(db);
    const club = (await db.one<{ name: string }>(`SELECT name FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.name;
    await page.goto(`/play/f/${token}`);
    await expect(card(page)).toContainText(EN.page_invited({ member: "Pat" }));
    await expect(card(page)).toContainText(club);
    await expect(card(page)).toContainText(/\w{3} \d+ \w{3}, \d{2}:\d{2}/);
    await expect(card(page)).toContainText(EN.page_explain);
    await expect(page.getByLabel(poolPageCopy("en").fields.nameLabel, { exact: true })).toHaveValue("Ali");
    await expect(page.locator('input[type="tel"]')).toHaveCount(0);
  });

  test("he fills it in and sends it: the WhatsApp step, and a waiting sign-up that carries the link", async ({ page, db }) => {
    const token = await seedLink(db);
    await page.goto(`/play/f/${token}`);
    await page.getByLabel(PLAY.fields.districtLabel, { exact: true }).fill("sm1");
    await page.getByRole("checkbox", { name: "Tuesday", exact: true }).check();
    await page.getByLabel(PLAY.fields.fromLabel("Tuesday")).selectOption("19:00");
    await page.getByLabel(PLAY.fields.toLabel("Tuesday")).selectOption("22:00");
    await page.getByRole("checkbox", { name: "7-a-side" }).check();
    await page.getByRole("checkbox", { name: PLAY.signup.adultLabel }).check();
    await page.getByRole("checkbox", { name: PLAY.signup.consentLabel }).check();
    await page.getByRole("button", { name: PLAY.signup.submit }).click();
    await expect(page.getByRole("heading", { name: PLAY.signup.confirmHeading })).toBeVisible();
    const row = await db.one<{ status: string; source: string; friendLinkId: string | null; displayName: string }>(
      `SELECT status, source, "friendLinkId", "displayName" FROM "PoolProfile" ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(row).toMatchObject({ status: "pending-verify", source: "friend", displayName: "Ali" });
    expect(row!.friendLinkId).toBeTruthy();
  });

  test("an unnamed friend: the name starts empty", async ({ page, db }) => {
    const token = await seedLink(db, { friendName: null });
    await page.goto(`/play/f/${token}`);
    await expect(card(page)).toBeVisible();
    await expect(page.getByLabel(poolPageCopy("en").fields.nameLabel, { exact: true })).toHaveValue("");
  });

  test("a used link says so, with the plain sign-up", async ({ page, db }) => {
    const token = await seedLink(db, { used: true });
    await page.goto(`/play/f/${token}`);
    await expect(page.getByText(EN.page_used)).toBeVisible();
    await expect(page.getByRole("link", { name: EN.page_pool_cta })).toHaveAttribute("href", "/play");
    await expect(card(page)).toHaveCount(0);
  });

  test("a called-off game and a started one say so", async ({ page, db }) => {
    const token = await seedLink(db);
    await db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id = $1`, [MATCH.upcoming]);
    await page.goto(`/play/f/${token}`);
    await expect(page.getByText(EN.page_called_off)).toBeVisible();
    await db.run(`UPDATE "Match" SET status = 'UPCOMING', date = now() - interval '5 minutes' WHERE id = $1`, [MATCH.upcoming]);
    await page.goto(`/play/f/${token}`);
    await expect(page.getByText(EN.page_started)).toBeVisible();
  });

  test("a token we did not sign", async ({ page }) => {
    await page.goto(`/play/f/clnotreal.AAAAAAAAAAAAAAAAAAAAAA`);
    await expect(page.getByText(EN.page_invalid)).toBeVisible();
  });
});

test.describe("Turkish", () => {
  test.use({ locale: "tr-TR" });

  test("the card and a used link in Turkish", async ({ page, db }) => {
    const token = await seedLink(db);
    await page.goto(`/play/f/${token}`);
    await expect(card(page)).toContainText(TR.page_invited({ member: "Pat" }));
    await expect(card(page)).toContainText(TR.page_explain);
    const used = await seedLink(db, { used: true });
    await page.goto(`/play/f/${used}`);
    await expect(page.getByText(TR.page_used)).toBeVisible();
  });
});
