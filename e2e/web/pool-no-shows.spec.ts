/**
 * Marking no-shows, blocks and reports in the browser (local player pool,
 * slice L7), at phone and desktop width. The WhatsApp side of the same
 * flows is in e2e/sim/pool/no-shows.spec.ts and blocks-reports.spec.ts.
 *
 * The world: the e2e club's game that kicked off two hours ago, with a pool
 * guest (Ali Khan) who held a place, and an older game he did not turn up
 * to. Ali's phone and area never reach the organisers' pages.
 */
import type { Page } from "@playwright/test";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const P = "e2e-ns";
const ALI = `${P}-ali`;
const GAME = `${P}-m-today`;
const OLD = `${P}-m-old`;
const SECRETS = ["+447700900991", "07700900991", "SM9"];
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const H = 3600_000;

async function seed(db: TestDb) {
  await db.run(`INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Ali Khan',$2,'+447700900991',true,true,now())`, [ALI, `${ALI}@e2e-test.invalid`]);
  for (const [id, at, status] of [
    [GAME, new Date(Date.now() - 2 * H), "COMPLETED"],
    [OLD, new Date(Date.now() - 12 * 24 * H), "COMPLETED"],
  ] as const) {
    await db.run(`INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,$2,$3,14,$4::"MatchStatus",$3,now())`, [id, ACTIVITY_ID, at, status]);
  }
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"guestMatchId","guestVia","createdAt") VALUES ($1,$2,$3,'PLAYER',$4,'pool',now())`, [`${P}-mem`, ALI, ORG_ID, GAME]);
  await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ($1,$2,$3,'CONFIRMED',20,now(),now())`, [`${P}-att`, GAME, ALI]);
  await db.run(`INSERT INTO "GuestPlace" (id,"orgId","matchId","userId",source,result,"updatedAt") VALUES ($1,$2,$3,$4,'pool','booked',now())`, [`${P}-gp1`, ORG_ID, GAME, ALI]);
  await db.run(
    `INSERT INTO "GuestPlace" (id,"orgId","matchId","userId",source,result,"resultAt","settledAt","updatedAt") VALUES ($1,$2,$3,$4,'pool','played',now(),now(),now())`,
    [`${P}-gp0`, ORG_ID, OLD, ALI],
  );
  await db.run(
    `INSERT INTO "PoolProfile" (id,"userId",status,"consentAt","consentVersion","consentChannel","consentEvidence","adultConfirmedAt","displayName","areaDistrict","areaLat","areaLng","updatedAt")
     VALUES ($1,$2,'active',now(),1,'whatsapp','wamid-e2e-ns',now(),'Ali K','SM9',51.36,-0.19,now())`,
    [`${P}-pp`, ALI],
  );
  await db.run(`INSERT INTO "PoolSport" (id,"profileId",sport,"otherName",formats) VALUES ($1,$2,'football','','{5}')`, [`${P}-ps`, `${P}-pp`]);
}

async function expectNoSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function expectNoSecrets(page: Page) {
  const html = await page.content();
  for (const s of SECRETS) expect(html, `leaked ${s}`).not.toContain(s);
}

test.beforeAll(async () => {
  resetDb();
});
test.afterAll(() => resetDb());

test("seed", async ({ db }) => {
  await seed(db);
});

for (const [label, size] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  test(`match page (${label}): the organiser marks a no-show and puts it back; the guest's record shows; nothing leaks`, async ({ page, db }) => {
    await page.setViewportSize(size);
    await signInAs(page, U.admin, `/matches/${GAME}`);
    await page.goto(`/matches/${GAME}`);
    const panel = page.getByTestId("guest-results-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("heading")).toHaveText("Did your guests turn up?");
    await expect(page.getByTestId("guest-results-hint")).toContainText("A guest you don't mark counts as played.");
    const row = panel.getByTestId("guest-result-row");
    await expect(row).toContainText("Ali K");
    await expect(row).toContainText("Turned up to 1 of 1 game");
    await expect(row.getByTestId("guest-turned-up")).toHaveAttribute("aria-pressed", "true");

    await row.getByTestId("guest-no-show").click();
    await expect(row).toHaveAttribute("data-result", "no-show");
    await expect(row.getByTestId("guest-no-show")).toHaveAttribute("aria-pressed", "true");
    expect((await db.one<{ result: string }>(`SELECT result FROM "GuestPlace" WHERE id = $1`, [`${P}-gp1`]))?.result).toBe("no-show");

    await row.getByTestId("guest-turned-up").click();
    await expect(row).toHaveAttribute("data-result", "played");
    expect((await db.one<{ result: string }>(`SELECT result FROM "GuestPlace" WHERE id = $1`, [`${P}-gp1`]))?.result).toBe("booked");
    await expectNoSideScroll(page);
    await expectNoSecrets(page);
  });
}

test("a player of the club sees no marking panel and no guest card", async ({ page }) => {
  await signInAs(page, U.player, `/matches/${GAME}`);
  await page.goto(`/matches/${GAME}`);
  await expect(page.getByTestId("attendance-section")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("guest-results-panel")).toHaveCount(0);
  await expect(page.getByTestId("guest-card-open")).toHaveCount(0);
});

for (const [label, size] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  test(`guest card (${label}): stop offering our games, then offer again; report a problem`, async ({ page, db }) => {
    await page.setViewportSize(size);
    await db.run(`DELETE FROM "PoolBlock" WHERE "userId" = $1`, [ALI]);
    await db.run(`DELETE FROM "PoolReport" WHERE "userId" = $1`, [ALI]);
    await signInAs(page, U.admin, "/admin/guests?tab=history");
    await page.goto("/admin/guests?tab=history");
    await expect(page.getByTestId("guest-history-row")).toBeVisible({ timeout: 30_000 });
    // The game two hours ago is waiting for its result.
    await expect(page.getByTestId("guest-history-game").first()).toContainText("Result due");
    await page.getByTestId("guest-card-open").first().click();
    const card = page.getByTestId("guest-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("guest-block")).toHaveText("Don't offer this player our games again");
    await expect(card).toContainText("The player is not told.");
    await card.getByTestId("guest-block").click();
    await expect(card.getByTestId("guest-blocked")).toBeVisible();
    await expect(card.getByTestId("guest-block")).toHaveText("Offer our games again");
    expect(await db.count(`SELECT count(*) FROM "PoolBlock" WHERE "userId" = $1 AND by = 'club'`, [ALI])).toBe(1);
    await card.getByTestId("guest-block").click();
    await expect(card.getByTestId("guest-block")).toHaveText("Don't offer this player our games again");
    expect(await db.count(`SELECT count(*) FROM "PoolBlock" WHERE "userId" = $1`, [ALI])).toBe(0);

    await card.getByTestId("guest-report-open").click();
    await card.getByTestId("guest-report-send").click();
    await expect(card.getByTestId("guest-report-error")).toHaveText("Please say a little more about what happened.");
    await card.getByTestId("guest-report-text").fill("He was rude to the referee.");
    await card.getByTestId("guest-report-send").click();
    await expect(card.getByTestId("guest-report-sent")).toBeVisible();
    expect(await db.count(`SELECT count(*) FROM "PoolReport" WHERE "userId" = $1 AND by = 'club'`, [ALI])).toBe(1);
    await expectNoSideScroll(page);
    await expectNoSecrets(page);
  });
}

for (const [label, size] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  test(`his manage page (${label}): his record, the clubs that offered him games, stop one's offers and report it`, async ({ page, db }) => {
    await page.setViewportSize(size);
    await db.run(`DELETE FROM "PoolBlock" WHERE "userId" = $1`, [ALI]);
    await signInAs(page, ALI, "/play/manage");
    await page.goto("/play/manage");
    await expect(page.getByTestId("pool-record")).toHaveText("You turned up to 1 of 1 game you said yes to.", { timeout: 30_000 });
    const row = page.getByTestId("pool-club-row");
    await expect(row).toHaveCount(1);
    await row.getByTestId("pool-club-block").click();
    await expect(row).toHaveAttribute("data-blocked", "yes");
    await expect(row.getByTestId("pool-club-block")).toHaveText("Get its offers again");
    await row.getByTestId("pool-club-block").click();
    await expect(row).toHaveAttribute("data-blocked", "no");
    await row.getByTestId("pool-club-report-open").click();
    await row.getByTestId("pool-club-report-text").fill("The pitch was locked when I arrived.");
    await row.getByTestId("pool-club-report-send").click();
    await expect(row.getByTestId("pool-club-report-sent")).toBeVisible();
    await expectNoSideScroll(page);
  });
}

test("paused for no-shows: the reason, when he can start again, and asking a person (Turkish too)", async ({ page, db }) => {
  await db.run(`UPDATE "PoolProfile" SET status = 'paused', "pausedReason" = 'no-shows', "pausedAt" = now(), "reviewRequestedAt" = NULL WHERE "userId" = $1`, [ALI]);
  await signInAs(page, ALI, "/play/manage");
  await page.goto("/play/manage");
  const note = page.getByTestId("pool-pause-note");
  await expect(note).toContainText("You can start game offers again from", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Resume game messages" })).toHaveCount(0);
  await page.getByTestId("pool-review-ask").click();
  await expect(page.getByTestId("pool-review-asked")).toHaveText("Asked. A person from the MatchTime team will look at it.");

  await db.run(`UPDATE "PoolProfile" SET language = 'tr', "reviewRequestedAt" = NULL WHERE "userId" = $1`, [ALI]);
  await page.reload();
  await expect(note).toContainText("Evet dediğin bazı maçlara gelmediğin için durduruldu.");
  await expect(page.getByTestId("pool-review-ask")).toHaveText("Bir kişinin bakmasını iste");

  // Thirty days on, he can start again himself.
  await db.run(`UPDATE "PoolProfile" SET language = 'en', "pausedAt" = now() - interval '31 days' WHERE "userId" = $1`, [ALI]);
  await page.reload();
  await expect(note).toContainText("You can start game offers again now.");
  await expect(page.getByRole("button", { name: "Resume game messages" })).toBeVisible();
});

test("the owner's safety page: open reports, the pause and the review asked, and lifting it", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await db.run(`UPDATE "PoolProfile" SET status = 'paused', "pausedReason" = 'no-shows', "pausedAt" = now(), "reviewRequestedAt" = now() WHERE "userId" = $1`, [ALI]);
  for (const size of [PHONE, DESKTOP]) {
    await page.setViewportSize(size);
    await signInAs(page, U.admin, "/admin/pool/safety");
    await page.goto("/admin/pool/safety");
    await expect(page.getByTestId("pool-safety-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ps-report").first()).toBeVisible();
    await expect(page.getByTestId("ps-pause")).toContainText("No-shows since");
    await expect(page.getByTestId("ps-review-asked")).toBeVisible();
    await expectNoSideScroll(page);
  }
  const before = await db.count(`SELECT count(*) FROM "PoolReport" WHERE "reviewedAt" IS NULL`);
  await page.getByTestId("ps-reviewed").first().click();
  await expect.poll(() => db.count(`SELECT count(*) FROM "PoolReport" WHERE "reviewedAt" IS NULL`)).toBe(before - 1);
  await page.getByTestId("ps-lift").click();
  await expect(page.getByTestId("ps-pause")).toHaveCount(0);
  expect(await db.one(`SELECT status, "pausedReason" FROM "PoolProfile" WHERE "userId" = $1`, [ALI])).toEqual({ status: "active", pausedReason: null });
});

test("the safety page is the owner's alone", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin/pool/safety");
  const res = await page.goto("/admin/pool/safety");
  expect(res?.status()).toBe(404);
});
