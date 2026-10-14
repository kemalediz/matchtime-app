/**
 * /admin/settings, the "Posters" card (2026-10-14), and the platform
 * owner's sharing switch on /admin/clubs.
 *
 *   - an owner of a live club: the card after the weekly routine, its ⓘ,
 *     both previews drawn and marked as samples (4 of 5 is too few names),
 *     the gallery with the MatchTime design in use; an upload is used at
 *     once, and Remove goes back to the default;
 *   - a Turkish club: the card in Turkish;
 *   - a club that is setting up: the card right under the Go live banner;
 *   - a player: no card;
 *   - the platform owner: a template's display name may not carry its
 *     club's name; with a neutral one, the template is shared.
 *
 * Screenshots of the card go to tmp-graphics/ (gitignored). Every picture
 * is an invented gradient; every club and person invented.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const SHOTS = path.join(process.cwd(), "tmp-graphics");

async function gradient(): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test("an owner: the card, its ⓘ, sample previews, the gallery; upload then remove", async ({ page, db }) => {
  await page.setViewportSize({ width: 1100, height: 1400 });
  await signInAs(page, U.admin, "/admin/settings");
  const card = page.getByTestId("posters-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading", { name: "Posters" })).toBeVisible();

  // Live club: after the weekly routine, not at the top.
  const order = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[data-testid="weekly-routine"], [data-testid="posters-card"]')).map((e) => e.getAttribute("data-testid"));
    return ids;
  });
  expect(order).toEqual(["weekly-routine", "posters-card"]);

  await card.getByRole("button", { name: "What is Posters?" }).click();
  await expect(page.getByText(/sends them to your admin group, ready to forward/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await expect(card.getByTestId("poster-preview-list")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(card.getByTestId("poster-preview-teams")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(card.getByTestId("poster-preview-list")).toHaveAttribute("alt", "List poster: E2E Test FC");
  await expect(card.getByTestId("posters-sample")).toBeVisible();

  const matchtime = card.getByTestId("poster-design-matchtime");
  await expect(matchtime).toHaveAttribute("aria-pressed", "true");
  await expect(matchtime).toContainText("MatchTime design");
  await expect(card.getByTestId("poster-design-own")).toHaveCount(0);

  mkdirSync(SHOTS, { recursive: true });
  await card.screenshot({ path: path.join(SHOTS, "posters-card-default.png") });

  // Upload: used at once.
  await card.getByTestId("posters-upload-input").setInputFiles({ name: "bg.png", mimeType: "image/png", buffer: await gradient() });
  await expect(card.getByTestId("posters-ok")).toHaveText("Background saved and in use.", { timeout: 30_000 });
  const own = card.getByTestId("poster-design-own");
  await expect(own).toHaveAttribute("aria-pressed", "true");
  await expect(own).toContainText("Your background");
  await expect(matchtime).toHaveAttribute("aria-pressed", "false");
  await expect(card.getByTestId("posters-upload")).toHaveText("Upload a new background");
  expect(await db.one(`SELECT kind FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toEqual({ kind: "background" });
  await expect(card.getByTestId("poster-preview-list")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(card.getByTestId("poster-preview-teams")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await card.screenshot({ path: path.join(SHOTS, "posters-card-background.png") });

  // A bad file: the reason, nothing changed.
  await card.getByTestId("posters-upload-input").setInputFiles({ name: "a.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a" + "x".repeat(64)) });
  await expect(card.getByTestId("posters-error")).toHaveText("That is not a JPEG, PNG or WebP picture.");
  await expect(own).toHaveAttribute("aria-pressed", "true");

  // Back to the MatchTime design by picking it; the upload is kept.
  await matchtime.click();
  await expect(card.getByTestId("posters-ok")).toHaveText("Design saved. MatchTime uses it from now on.");
  await expect(matchtime).toHaveAttribute("aria-pressed", "true");
  expect(await db.one(`SELECT design FROM "ClubGraphicsChoice" WHERE "orgId" = $1`, [ORG_ID])).toEqual({ design: "matchtime" });

  // Remove.
  await card.getByTestId("posters-remove").click();
  await expect(card.getByTestId("posters-ok")).toHaveText("Background removed.");
  await expect(card.getByTestId("poster-design-own")).toHaveCount(0);
  await expect(card.getByTestId("posters-remove")).toHaveCount(0);
  expect(await db.all(`SELECT 1 FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toHaveLength(0);
});

test("a Turkish club: the card in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings");
  const card = page.getByTestId("posters-card");
  await expect(card.getByRole("heading", { name: "Afişler" })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("poster-design-matchtime")).toContainText("MatchTime tasarımı");
  await expect(card.getByTestId("posters-upload")).toHaveText("Arka plan yükle");
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("a player: no Posters card", async ({ page }) => {
  await signInAs(page, U.player, "/admin/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("posters-card")).toHaveCount(0);
});

async function heldClub(db: TestDb) {
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ('e2e-post-hana','Hana Harbour','e2e-post-hana@e2e-test.invalid','+447700903101',true,true,now())`,
  );
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId","whatsappBotEnabled","setupStage","language","createdAt","updatedAt")
     VALUES ('e2e-post-harb','Harbour FC','e2e-post-harb','e2e-post-harb-invite','approved',now() - interval '3 hours','120363900000000391@g.us',false,'setting-up','en',now(),now())`,
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ('e2e-post-hana-m','e2e-post-hana','e2e-post-harb','OWNER')`);
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt","updatedAt")
     VALUES ('e2e-post-harb-cc','e2e-post-harb','e2e-post-hana','447700903101','HARB','closed',now() + interval '1 hour','120363900000000391@g.us','Harbour Tuesday 6s',now() - interval '4 hours',now())`,
  );
}

test("a club setting up: the card right under the Go live banner, with sample names", async ({ page, db }) => {
  await heldClub(db);
  await signInAs(page, "e2e-post-hana", "/admin/settings");
  await expect(page.getByTestId("go-live-banner")).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId("posters-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const next = await page.evaluate(() => document.querySelector('[data-testid="go-live-banner"]')?.nextElementSibling?.getAttribute("data-testid"));
  expect(next).toBe("posters-card");
  await expect(card.getByTestId("posters-sample")).toBeVisible();
  await expect(card.getByTestId("poster-preview-list")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
});

test("the platform owner shares a template: never under the club's own name", async ({ page, db }) => {
  const image = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 20, g: 90, b: 60 } } }).jpeg().toBuffer();
  await db.run(
    `INSERT INTO "ClubGraphicsTemplate" ("orgId", image, "mimeType", layout, kind, "updatedAt") VALUES ($1, $2, 'image/jpeg', '{"width":1080,"height":1350}'::jsonb, 'background', now())`,
    [ORG_ID, image],
  );
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.waitForURL("**/admin/clubs");
  const row = page.getByTestId("poster-template");
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText("E2E Test FC");
  await expect(row).toContainText("uploaded background");

  await row.getByTestId("template-display-name").fill("E2E Test FC board");
  await row.getByTestId("template-shared").click();
  await expect(page.getByText("The display name must not carry the club's own name.")).toBeVisible();
  expect(await db.one(`SELECT shared FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toEqual({ shared: false });

  await row.getByTestId("template-display-name").fill("Green pitch");
  await row.getByTestId("template-shared").click();
  await expect(row.getByTestId("template-shared")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  expect(await db.one(`SELECT shared, "displayName" FROM "ClubGraphicsTemplate" WHERE "orgId" = $1`, [ORG_ID])).toEqual({ shared: true, displayName: "Green pitch" });

  // Another club now sees it in its gallery, by that name.
  await signInAs(page, "e2e-post-hana", "/admin/settings");
  const card = page.getByTestId("posters-card");
  await expect(card.getByTestId(`poster-design-shared:${ORG_ID}`)).toContainText("Green pitch", { timeout: 30_000 });
  await expect(card).not.toContainText("E2E Test FC");
});
