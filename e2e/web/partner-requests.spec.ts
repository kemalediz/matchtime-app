/**
 * Partner requests (partner discovery, slice P3, 2026-10-22), END TO END
 * through the settings page, the real server actions and the real writer.
 * Plan: MDs/partner-discovery-plan-2026-10-21.md, sections 3.1 to 3.5.
 *
 *   - club A sends requests to two clubs (here from the one-tap "Ask them
 *     for players too" on two pairings that let those clubs ask A; the
 *     search page that also sends is P2's); each club's organisers get the
 *     request notice, tagged for a WhatsApp reply;
 *   - club B1's owner accepts with "Check each ask with us first", club
 *     B2's owner declines; A sees one active pairing and no pending
 *     request, and A's organisers were told both outcomes;
 *   - A withdraws a request; B1 blocks A from the settings page (the
 *     pairing ends, A cannot ask again), then unblocks;
 *   - all of it in Turkish too.
 *
 * Stubbed suite: no model call ($0).
 */
import { test, expect, resetDb, U, mintToken } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import type { Page } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const B1 = "e2e-pr-cheam";
const B2 = "e2e-pr-ewell";
const OWNER_B1 = U.rater;
const OWNER_B2 = U.third;

/** Sign in AS a user, pinned to one club (a user in two clubs). */
async function signInFor(page: Page, userId: string, orgId: string, nextPath = "/admin/settings") {
  await page.goto(`/r/${mintToken(userId, { nextPath, orgId })}`);
  await page.waitForURL((url) => !url.pathname.startsWith("/r/"), { timeout: 30_000 });
}

const pairing = (db: TestDb, asker: string, partner: string) =>
  db.one<{ id: string; status: string; origin: string; partnerApproval: string; endReason: string | null; askerAcceptedAt: Date | null }>(
    `SELECT id, status, origin, "partnerApproval", "endReason", "askerAcceptedAt" FROM "ClubPartnership" WHERE "askerOrgId" = $1 AND "partnerOrgId" = $2`,
    [asker, partner],
  );
const jobs = (db: TestDb, orgId: string) =>
  db.all<{ text: string; aboutKey: string | null }>(`SELECT text, "aboutKey" FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt" ASC`, [orgId]);

let orgName = "";

test.beforeAll(async ({ db }) => {
  resetDb();
  orgName = (await db.one<{ name: string }>(`SELECT name FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.name;
  for (const [id, name, owner] of [
    [B1, "Cheam Lads", OWNER_B1],
    [B2, "Ewell Rovers", OWNER_B2],
  ] as const) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt") VALUES ($1,$2,$1,$3,'approved',now(),now())`,
      [id, name, `${id}-invite`],
    );
    await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'OWNER',now())`, [`${id}-owner`, owner, id]);
    // That club may already ask A (it asked, and A accepted).
    await db.run(
      `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,origin,"partnerApproval","askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
       VALUES ($1,$2,$3,'active','request','standing',now(),now(),$4,now(),now())`,
      [`${id}-asks-a`, id, ORG_ID, owner],
    );
  }
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id IN ($1, $2, $3)`, [ORG_ID, B1, B2]);
  resetDb();
});

test("A sends requests to two clubs; each club's organisers get the request notice", async ({ page, db }) => {
  await signInFor(page, U.admin, ORG_ID);
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId("partner-find-link")).toHaveAttribute("href", "/admin/partners/find");
  await expect(section.getByTestId("partner-find-link")).toHaveText("Find clubs near you");

  for (const name of ["Cheam Lads", "Ewell Rovers"]) {
    const row = section.getByTestId("partner-club").filter({ hasText: `${name} may ask you for players` });
    await row.getByRole("button", { name: `Ask ${name} for players too` }).click();
    await expect(section.getByTestId("partner-request-out").filter({ hasText: `You asked ${name} for players` })).toBeVisible({ timeout: 15_000 });
  }
  const out = section.getByTestId("partner-request-out");
  await expect(out).toHaveCount(2);
  await expect(out.first()).toContainText("Waiting for");

  for (const id of [B1, B2]) {
    const p = await pairing(db, ORG_ID, id);
    expect(p).toMatchObject({ status: "proposed", origin: "request", partnerApproval: "standing" });
    expect(p!.askerAcceptedAt).not.toBeNull();
    const notice = (await jobs(db, id)).find((j) => j.aboutKey === `pairing:${p!.id}:${id}`);
    expect(notice?.text).toContain(`*${orgName}* (`);
    expect(notice?.text).toContain("would like to ask");
    expect(notice?.text).toMatch(/Reply \*1\* to accept or \*2\* to decline, or open https?:\/\/\S+$/);
  }
});

test("B1's owner accepts with 'Check each ask with us first'; B2's owner declines", async ({ page, db }) => {
  await signInFor(page, OWNER_B1, B1);
  let section = page.getByTestId("partner-clubs");
  let req = section.getByTestId("partner-request-in");
  await expect(req).toHaveCount(1, { timeout: 30_000 });
  await expect(req).toContainText(`${orgName} would like to ask you for players`);
  // The default is "Post their asks straight away".
  await expect(req.getByTestId("request-choice")).toHaveValue("standing");
  await req.getByTestId("request-choice").selectOption("each-ask");
  await req.getByTestId("request-accept").click();
  await expect(section.getByTestId("partner-request-in")).toHaveCount(0, { timeout: 15_000 });
  await expect(section.getByTestId("partner-club").filter({ hasText: `${orgName} may ask you for players` })).toContainText("Active");
  expect(await pairing(db, ORG_ID, B1)).toMatchObject({ status: "active", partnerApproval: "each-ask" });

  await signInFor(page, OWNER_B2, B2);
  section = page.getByTestId("partner-clubs");
  req = section.getByTestId("partner-request-in");
  await expect(req).toHaveCount(1, { timeout: 30_000 });
  await req.getByTestId("request-decline").click();
  await expect(section.getByTestId("partner-request-in")).toHaveCount(0, { timeout: 15_000 });
  expect(await pairing(db, ORG_ID, B2)).toMatchObject({ status: "ended", endReason: "declined" });
});

test("A sees both outcomes: Cheam Lads active, Ewell Rovers no longer pending, and was told each", async ({ page, db }) => {
  await signInFor(page, U.admin, ORG_ID);
  const section = page.getByTestId("partner-clubs");
  await expect(section).toBeVisible({ timeout: 30_000 });
  const cheam = section.getByTestId("partner-club").filter({ hasText: "You may ask Cheam Lads for players" });
  await expect(cheam.getByTestId("partner-club-status")).toHaveText("Active");
  await expect(section.getByTestId("partner-request-out")).toHaveCount(0);
  await expect(section.getByTestId("partner-club").filter({ hasText: "You may ask Ewell Rovers" })).toHaveCount(0);
  // The 30-day wait: Ewell's "ask them too" is refused.
  await section
    .getByTestId("partner-club")
    .filter({ hasText: "Ewell Rovers may ask you for players" })
    .getByRole("button", { name: "Ask Ewell Rovers for players too" })
    .click();
  await expect(page.getByText("That can't be done now. Reload the page and try again.")).toBeVisible({ timeout: 15_000 });
  expect(await pairing(db, ORG_ID, B2)).toMatchObject({ status: "ended", endReason: "declined" });

  const told = (await jobs(db, ORG_ID)).map((j) => j.text);
  expect(told.some((t) => t.includes(`*Cheam Lads* accepted *${orgName}*'s request`))).toBe(true);
  expect(told).toContain("*Ewell Rovers* is not taking requests right now.");
});

test("A withdraws a pending request; it leaves both lists", async ({ page, db }) => {
  // A request to Ewell long after the wait (as if 31 days on).
  await db.run(
    `UPDATE "ClubPartnership" SET "endedAt" = (now() AT TIME ZONE 'UTC') - interval '31 days' WHERE "askerOrgId" = $1 AND "partnerOrgId" = $2`,
    [ORG_ID, B2],
  );
  await signInFor(page, U.admin, ORG_ID);
  const section = page.getByTestId("partner-clubs");
  await section
    .getByTestId("partner-club")
    .filter({ hasText: "Ewell Rovers may ask you for players" })
    .getByRole("button", { name: "Ask Ewell Rovers for players too" })
    .click({ timeout: 30_000 });
  const out = section.getByTestId("partner-request-out");
  await expect(out).toHaveCount(1, { timeout: 15_000 });
  await out.getByTestId("request-withdraw").click();
  await expect(section.getByTestId("partner-request-out")).toHaveCount(0, { timeout: 15_000 });
  expect(await pairing(db, ORG_ID, B2)).toMatchObject({ status: "ended", endReason: "withdrawn" });
});

test("B1 blocks A from the settings page: the pairing ends and A cannot ask again; B1 unblocks", async ({ page, db }) => {
  await signInFor(page, OWNER_B1, B1);
  const section = page.getByTestId("partner-clubs");
  const row = section.getByTestId("partner-club").filter({ hasText: `${orgName} may ask you for players` });
  page.once("dialog", (d) => d.accept());
  await row.getByTestId("partner-block").click({ timeout: 30_000 });
  const blocked = section.getByTestId("blocked-club");
  await expect(blocked).toHaveCount(1, { timeout: 15_000 });
  await expect(blocked).toContainText(orgName);
  expect(await pairing(db, ORG_ID, B1)).toMatchObject({ status: "ended", endReason: "blocked" });
  expect(await db.one(`SELECT 1 AS x FROM "ClubBlock" WHERE "blockerOrgId" = $1 AND "blockedOrgId" = $2`, [B1, ORG_ID])).not.toBeNull();

  // A cannot ask B1 again while blocked.
  await signInFor(page, U.admin, ORG_ID);
  const a = page.getByTestId("partner-clubs");
  await a
    .getByTestId("partner-club")
    .filter({ hasText: "Cheam Lads may ask you for players" })
    .getByRole("button", { name: "Ask Cheam Lads for players too" })
    .click({ timeout: 30_000 });
  await expect(page.getByText("That can't be done now. Reload the page and try again.")).toBeVisible({ timeout: 15_000 });
  expect(await pairing(db, ORG_ID, B1)).toMatchObject({ status: "ended", endReason: "blocked" });

  // B1 unblocks.
  await signInFor(page, OWNER_B1, B1);
  const again = page.getByTestId("partner-clubs");
  await again.getByTestId("blocked-club").getByTestId("blocked-unblock").click({ timeout: 30_000 });
  await expect(again.getByTestId("blocked-club")).toHaveCount(0, { timeout: 15_000 });
  expect(await db.one(`SELECT 1 AS x FROM "ClubBlock" WHERE "blockerOrgId" = $1`, [B1])).toBeNull();
});

test("in Turkish: the request, its choice, the outcome and the block list", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id IN ($1, $2)`, [ORG_ID, B1]);
  // Unblocked, and no wait after a block: A asks B1 again.
  await signInFor(page, U.admin, ORG_ID);
  const a = page.getByTestId("partner-clubs");
  await expect(a.getByTestId("partner-find-link")).toHaveText("Yakınınızdaki kulüpleri bulun", { timeout: 30_000 });
  await a
    .getByTestId("partner-club")
    .filter({ hasText: "Cheam Lads sizden oyuncu isteyebilir" })
    .getByRole("button", { name: "Siz de Cheam Lads kulübünden oyuncu isteyin" })
    .click();
  await expect(a.getByTestId("partner-requests-out")).toContainText("Gönderdiğiniz istekler", { timeout: 15_000 });
  await expect(a.getByTestId("partner-request-out")).toContainText("Cheam Lads kulübünden oyuncu istediniz");
  const p = await pairing(db, ORG_ID, B1);
  const notice = (await jobs(db, B1)).find((j) => j.aboutKey === `pairing:${p!.id}:${B1}` && j.text.includes("oyuncu istemek istiyor"));
  expect(notice?.text).toMatch(/Kabul etmek için \*1\*, reddetmek için \*2\* yazın ya da şunu açın: https?:\/\/\S+$/);

  await signInFor(page, OWNER_B1, B1);
  const b = page.getByTestId("partner-clubs");
  const req = b.getByTestId("partner-request-in");
  await expect(b.getByTestId("partner-requests-in")).toContainText("Kulübünüze gelen istekler", { timeout: 30_000 });
  await expect(req).toContainText(`${orgName} sizden oyuncu istemek istiyor`);
  await expect(req.getByTestId("request-choice").locator("option")).toHaveText(["İsteklerini hemen paylaş", "Her isteği önce bize sor"]);
  page.once("dialog", (d) => d.accept());
  await req.getByRole("button", { name: "Engelle" }).click();
  await expect(b.getByTestId("partner-blocked")).toContainText("Engellenen kulüpler", { timeout: 15_000 });
  await expect(b.getByTestId("blocked-unblock")).toHaveText("Engeli kaldır");
  expect(await pairing(db, ORG_ID, B1)).toMatchObject({ status: "ended", endReason: "blocked" });
});
