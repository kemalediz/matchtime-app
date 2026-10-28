/**
 * Partner clubs (cross-club ask, slice S1, 2026-10-16; partner discovery,
 * slices P1 and P5, 2026-10-22).
 * Plans: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1 and 3.2;
 * MDs/partner-discovery-plan-2026-10-21.md, sections 2.1 and 3.5.
 *
 *   - EVERY club sees the section now, with "Let nearby clubs find us and
 *     send requests" (on, for an existing club) and "Accept partner
 *     requests automatically" (off), each with its ⓘ, and the venue
 *     prompt while it has no venue; an owner and an admin switch them;
 *   - the platform owner's page lists pairings with pause and end, and no
 *     create form; a platform pause shows on the club's page and only the
 *     platform resumes it;
 *   - the club's OWNER accepts on /admin/settings, then the asking
 *     settings and their ⓘ appear and save;
 *   - all of it in Turkish;
 *   - a PLAYER of the club cannot reach the section's data at all.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-pc-sutton";

const row = async (db: TestDb) =>
  db.one<{ status: string; askerAcceptedAt: Date | null; partnerAcceptedAt: Date | null; pausedByOrgId: string | null; endReason: string | null }>(
    `SELECT status, "askerAcceptedAt", "partnerAcceptedAt", "pausedByOrgId", "endReason" FROM "ClubPartnership" WHERE "askerOrgId" = $1 AND "partnerOrgId" = $2`,
    [ORG_ID, PARTNER],
  );
const orgSettings = async (db: TestDb) =>
  db.one<{ when: string; cutoff: number; time: string | null }>(
    `SELECT "partnerAskWhen" AS when, "partnerAskCutoffHours" AS cutoff, "partnerAskTime" AS time FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );
const discovery = async (db: TestDb) =>
  db.one<{ discoverable: boolean; by: string | null; at: Date | null; auto: boolean }>(
    `SELECT discoverable, "discoverableById" AS by, "discoverableAt" AS at, "autoAcceptPartnerRequests" AS auto FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );

test.beforeAll(() => {
  resetDb();
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  resetDb();
});

test("no partner clubs: the section still shows, with both switches, their ⓘ and the venue prompt", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings#partner-clubs");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId("partner-clubs-none")).toHaveText("No partner clubs yet.");
  // The existing club reads as discoverable (default on); auto-accept off.
  const findUs = section.getByRole("switch", { name: "Let nearby clubs find us and send requests" });
  const autoAccept = section.getByRole("switch", { name: "Accept partner requests automatically" });
  await expect(findUs).toHaveAttribute("aria-checked", "true");
  await expect(autoAccept).toHaveAttribute("aria-checked", "false");
  // No venue: the prompt.
  await expect(section.getByTestId("club-venue-prompt")).toContainText("Confirm your venue to find clubs near you");
  // No asking settings until there is a partner club.
  await expect(section.getByTestId("partner-ask-when")).toHaveCount(0);

  // Each ⓘ says exactly what other clubs see, or what auto-accept does.
  await section.getByRole("button", { name: "What is Let nearby clubs find us and send requests?" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Other clubs see only: your club's name, your venue's name and town");
  await expect(sheet).toContainText("They never see your members' names or phone numbers");
  await page.getByRole("button", { name: "Close" }).click();
  await section.getByRole("button", { name: "What is Accept partner requests automatically?" }).click();
  await expect(page.getByRole("dialog")).toContainText("MatchTime accepts it straight away");
  await page.getByRole("button", { name: "Close" }).click();

  // The owner switches them.
  await findUs.click();
  await expect.poll(async () => (await discovery(db))?.discoverable).toBe(false);
  expect((await discovery(db))?.by).toBe(U.admin);
  expect((await discovery(db))?.at).not.toBeNull();
  await expect(findUs).toHaveAttribute("aria-checked", "false");
  await autoAccept.click();
  await expect.poll(async () => (await discovery(db))?.auto).toBe(true);
  await page.reload();
  await expect(section.getByRole("switch", { name: "Let nearby clubs find us and send requests" })).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await expect(section.getByRole("switch", { name: "Accept partner requests automatically" })).toHaveAttribute("aria-checked", "true");
});

test("an ADMIN (not the owner) switches them too", async ({ page, db }) => {
  await db.run(`UPDATE "Membership" SET role = 'ADMIN' WHERE "userId" = $1 AND "orgId" = $2`, [U.collector, ORG_ID]);
  await signInAs(page, U.collector, "/admin/settings#partner-clubs");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await section.getByRole("switch", { name: "Let nearby clubs find us and send requests" }).click();
  await expect.poll(async () => (await discovery(db))?.discoverable).toBe(true);
  expect((await discovery(db))?.by).toBe(U.collector);
  await section.getByRole("switch", { name: "Accept partner requests automatically" }).click();
  await expect.poll(async () => (await discovery(db))?.auto).toBe(false);
  await db.run(`UPDATE "Membership" SET role = 'PLAYER' WHERE "userId" = $1 AND "orgId" = $2`, [U.collector, ORG_ID]);
});

test("the platform owner's page: pairings with pause and end, and no create form", async ({ page, db }) => {
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt")
     VALUES ($1,'Sutton Partners',$1,$2,'approved',now(),now())`,
    [PARTNER, `${PARTNER}-invite`],
  );
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.getByTestId("partners-link").click();
  const list = page.getByTestId("partner-clubs-page");
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(list.getByText("No clubs are paired.")).toBeVisible();
  // The create form is gone (D-6).
  await expect(page.getByTestId("pair-asker")).toHaveCount(0);
  await expect(page.getByTestId("pair-partner")).toHaveCount(0);
  await expect(page.getByTestId("pair-clubs")).toHaveCount(0);

  // A pairing the clubs made (here, the row).
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"createdByUserId","createdAt","updatedAt")
     VALUES ('e2e-pc-pair',$1,$2,'proposed',$3,now(),now())`,
    [ORG_ID, PARTNER, U.admin],
  );
  await page.reload();
  const org = await db.one<{ name: string }>(`SELECT name FROM "Organisation" WHERE id = $1`, [ORG_ID]);
  const item = list.getByTestId("partnership");
  await expect(item).toContainText(`${org!.name} may ask Sutton Partners`, { timeout: 30_000 });
  // A proposed pairing can be ended, not paused.
  await expect(item.getByTestId("partnership-pause")).toHaveCount(0);
  await expect(item.getByTestId("partnership-end")).toBeVisible();
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

test("the owner accepts; once the partner accepts too the asking settings save, each with its ⓘ", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings#partner-clubs");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const item = section.getByTestId("partner-club");
  await expect(item).toContainText("You may ask Sutton Partners for players");
  await expect(item.getByTestId("partner-club-status")).toHaveText("Waiting for both owners to accept");
  await item.getByTestId("partner-accept").click();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Waiting for Sutton Partners's owner to accept", { timeout: 15_000 });
  expect((await row(db))?.askerAcceptedAt).not.toBeNull();

  // The other club's owner accepts (on their own page; here, the row).
  await db.run(`UPDATE "ClubPartnership" SET "partnerAcceptedAt" = now(), status = 'active' WHERE "askerOrgId" = $1`, [ORG_ID]);
  await page.reload();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Active", { timeout: 30_000 });

  // The ⓘ of the list opens and closes.
  await section.getByRole("button", { name: "What is Your partner clubs?" }).click();
  await expect(page.getByRole("dialog")).toContainText("Each pairing works one way");
  await page.getByRole("button", { name: "Close" }).click();

  // When to ask: Automatically shows the time row; the cut-off defaults to 4 hours.
  await expect(section.getByTestId("partner-ask-cutoff")).toHaveValue("4");
  await expect(section.getByTestId("partner-ask-time")).toHaveCount(0);
  await section.getByTestId("partner-ask-when").selectOption("auto");
  await expect.poll(async () => (await orgSettings(db))?.when).toBe("auto");
  await expect(section.getByTestId("partner-ask-time")).toHaveValue("16:00");
  await section.getByTestId("partner-ask-time").fill("17:30");
  await section.getByTestId("partner-ask-time").blur();
  await expect.poll(async () => (await orgSettings(db))?.time).toBe("17:30");
  await section.getByTestId("partner-ask-cutoff").selectOption("6");
  await expect.poll(async () => (await orgSettings(db))?.cutoff).toBe(6);

  await section.getByRole("button", { name: "What is Last ask before kickoff?" }).click();
  await expect(page.getByRole("dialog")).toContainText("You can choose from 1 to 24 hours.");
  await page.getByRole("button", { name: "Close" }).click();

  // Pause, then resume (the side that paused).
  await item.getByTestId("partner-pause").click();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Paused by you", { timeout: 15_000 });
  await item.getByTestId("partner-resume").click();
  await expect(item.getByTestId("partner-club-status")).toHaveText("Active", { timeout: 15_000 });
});

test("the platform owner pauses a pairing: the club sees it and cannot resume it; the platform resumes, then ends it", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin/clubs/partners");
  const item = page.getByTestId("partner-clubs-page").getByTestId("partnership");
  await expect(item).toHaveAttribute("data-status", "active", { timeout: 30_000 });
  await item.getByTestId("partnership-pause").click();
  await expect(item).toHaveAttribute("data-status", "paused", { timeout: 15_000 });
  expect((await row(db))?.pausedByOrgId).toBe("platform");
  await expect(item).toContainText("paused by MatchTime");

  // On the club's own page: "Paused by MatchTime", and no Resume.
  await page.goto("/admin/settings#partner-clubs");
  const clubItem = page.getByTestId("partner-clubs").getByTestId("partner-club");
  await expect(clubItem.getByTestId("partner-club-status")).toHaveText("Paused by MatchTime", { timeout: 30_000 });
  await expect(clubItem.getByTestId("partner-resume")).toHaveCount(0);

  // The platform resumes it, then ends it.
  await page.goto("/admin/clubs/partners");
  await item.getByTestId("partnership-resume").click();
  await expect(item).toHaveAttribute("data-status", "active", { timeout: 15_000 });
  page.once("dialog", (d) => d.accept());
  await item.getByTestId("partnership-end").click();
  await expect(item).toHaveAttribute("data-status", "ended", { timeout: 15_000 });
  expect((await row(db))?.endReason).toBe("ended");
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  // Back to an active pairing for the Turkish test below.
  await db.run(`UPDATE "ClubPartnership" SET status = 'active', "endReason" = NULL, "endedAt" = NULL WHERE "askerOrgId" = $1`, [ORG_ID]);
});

test("in Turkish: the section, both switches, the venue prompt and their ⓘ", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings#partner-clubs");
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText("Partner kulüpler", { exact: true })).toBeVisible();
  await expect(section.getByTestId("partner-club")).toContainText("Sutton Partners kulübünden oyuncu isteyebilirsiniz");
  await expect(section.getByRole("switch", { name: "Yakındaki kulüpler bizi bulsun ve istek göndersin" })).toBeVisible();
  await expect(section.getByRole("switch", { name: "Partner isteklerini otomatik kabul et" })).toBeVisible();
  await expect(section.getByTestId("club-venue-prompt")).toContainText("Yakınınızdaki kulüpleri bulmak için sahanızı onaylayın");

  await section.getByRole("button", { name: /Yakındaki kulüpler bizi bulsun/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Diğer kulüpler yalnızca şunları görür");
  await page.getByRole("button", { name: "Kapat" }).click();
  await section.getByRole("button", { name: /Partner isteklerini otomatik kabul et/ }).click();
  await expect(page.getByRole("dialog")).toContainText("isteği hemen kabul eder");
  await page.getByRole("button", { name: "Kapat" }).click();
  await section.getByRole("button", { name: /Partner kulüplerden oyuncu iste/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Belirli bir saatte kendiliğinden");
  await page.getByRole("button", { name: "Kapat" }).click();
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("a PLAYER of the club cannot see or change it", async ({ page }) => {
  await signInAs(page, U.player, "/admin/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("partner-clubs")).toHaveCount(0);
});
