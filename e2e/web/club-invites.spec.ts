/**
 * Joining a club's group in the app (local player pool, slice L8), at phone
 * and desktop width: the settings card for the group's invite link (option
 * A, MatchTime as group admin, and option B, a pasted link), Invite to club
 * on the guest card, and the player's My invitations page.
 *
 * The world: a pool guest (Ali Khan) who played yesterday's match with E2E
 * Test FC. The link is never on the guest card, the page of another player,
 * or My invitations.
 */
import type { Page } from "@playwright/test";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const P = "e2e-ci";
const ALI = `${P}-ali`;
const LINK = "https://chat.whatsapp.com/E2eL1nkAbCdEfGhIjKlMn0";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const SIZES = [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const;

async function expectNoSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(1);
}

async function seed(db: import("../helpers/test-db").TestDb) {
  await db.run(`INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Ali Khan',$2,'+447700900991',true,true,now())`, [ALI, `${ALI}@e2e-test.invalid`]);
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"guestMatchId","guestVia","createdAt") VALUES ($1,$2,$3,'PLAYER',$4,'pool',now())`, [`${P}-m`, ALI, ORG_ID, MATCH.rate]);
  await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ($1,$2,$3,'CONFIRMED',6,now(),now())`, [`${P}-a`, MATCH.rate, ALI]);
  await db.run(`INSERT INTO "GuestPlace" (id,"orgId","matchId","userId",source,result,"resultAt","updatedAt") VALUES ($1,$2,$3,$4,'pool','played',now(),now())`, [`${P}-g`, ORG_ID, MATCH.rate, ALI]);
  await db.run(
    `INSERT INTO "PoolProfile" (id,"userId",status,"consentAt","consentVersion","consentChannel","consentEvidence","adultConfirmedAt","displayName","areaDistrict","areaLat","areaLng","updatedAt")
     VALUES ($1,$2,'active',now(),1,'whatsapp','wamid-e2e-ci',now(),'Ali K','SM9',51.36,-0.19,now())`,
    [`${P}-pp`, ALI],
  );
}

const clearInvites = (db: import("../helpers/test-db").TestDb) => db.run(`DELETE FROM "ClubInvitation" WHERE "userId" = $1`, [ALI]);
const setLink = (db: import("../helpers/test-db").TestDb, link: string | null) => db.run(`UPDATE "Organisation" SET "groupInviteLink" = $2 WHERE id = $1`, [ORG_ID, link]);

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("the settings card and Invite to club are not shown to a club with the pool off (live clubs unchanged)", async ({ page, db }) => {
  await seed(db);
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("group-invite-link")).toHaveCount(0);
  await signInAs(page, U.admin, "/admin/guests?tab=history");
  await page.getByRole("button", { name: "About Ali K" }).click();
  await expect(page.getByTestId("guest-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("guest-invite")).toHaveCount(0);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);
});

for (const [label, size] of SIZES) {
  test(`settings card (${label}): A and B explained, a bad link refused, a good one saved and removed`, async ({ page, db }) => {
    await setLink(db, null);
    await page.setViewportSize(size);
    await signInAs(page, U.admin, "/admin/settings");
    const card = page.getByTestId("group-invite-link");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute("data-mode", "none");
    await expect(card.getByTestId("group-invite-link-status")).toHaveText("Not set up yet: guests cannot be invited to your group.");
    await expect(card.getByTestId("group-invite-link-option-a")).toContainText("make MatchTime an admin of your WhatsApp group");
    await expect(card.getByTestId("group-invite-link-option-b")).toContainText("paste your group's invite link below");
    await expect(card.getByTestId("group-invite-link-not-hq")).toHaveText("Paste the link of your players' group, not of your admin group.");

    await card.getByTestId("group-invite-link-input").fill("https://evil.example/join");
    await card.getByTestId("group-invite-link-save").click();
    await expect(card.getByTestId("group-invite-link-error")).toHaveText(/not a WhatsApp group invite link/, { timeout: 30_000 });
    expect((await db.one<{ l: string | null }>(`SELECT "groupInviteLink" AS l FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.l).toBeNull();

    await card.getByTestId("group-invite-link-input").fill(`  ${LINK}?mode=ems_copy_t `);
    await card.getByTestId("group-invite-link-save").click();
    await expect(card).toHaveAttribute("data-mode", "pasted", { timeout: 45_000 });
    await expect(card.getByTestId("group-invite-link-input")).toHaveValue(LINK);
    expect((await db.one<{ l: string | null }>(`SELECT "groupInviteLink" AS l FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.l).toBe(LINK);
    await expectNoSideScroll(page);

    await card.getByTestId("group-invite-link-remove").click();
    await expect(card).toHaveAttribute("data-mode", "none", { timeout: 45_000 });
  });
}

test("settings card: with MatchTime a group admin, option A is in use", async ({ page, db }) => {
  const g = await db.one<{ gid: string }>(`SELECT "whatsappGroupId" AS gid FROM "Organisation" WHERE id = $1`, [ORG_ID]);
  await db.run(
    `INSERT INTO "GroupPostState" ("groupId","botIsAdmin","canPost","observedAt","updatedAt") VALUES ($1,true,true,now(),now()) ON CONFLICT ("groupId") DO UPDATE SET "botIsAdmin" = true`,
    [g!.gid],
  );
  try {
    await signInAs(page, U.admin, "/admin/settings");
    const card = page.getByTestId("group-invite-link");
    await expect(card).toHaveAttribute("data-mode", "bot", { timeout: 30_000 });
    await expect(card.getByTestId("group-invite-link-status")).toHaveText("MatchTime is an admin of your group, so it gets the link itself.");
  } finally {
    await db.run(`UPDATE "GroupPostState" SET "botIsAdmin" = false WHERE "groupId" = $1`, [g!.gid]);
  }
});

for (const [label, size] of SIZES) {
  test(`Invite to club (${label}): greyed with how to set up a link, then the tap invites him privately`, async ({ page, db }) => {
    await clearInvites(db);
    await setLink(db, null);
    await page.setViewportSize(size);
    await signInAs(page, U.admin, "/admin/guests?tab=history");
    await page.getByRole("button", { name: "About Ali K" }).click();
    const card = page.getByTestId("guest-card");
    await expect(card.getByTestId("guest-invite")).toBeDisabled({ timeout: 30_000 });
    await expect(card.getByTestId("guest-invite-no-link")).toContainText("paste your group's invite link in Settings");
    await expect(card.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/admin/settings#group-invite-link");
    await page.keyboard.press("Escape");

    await setLink(db, LINK);
    await page.reload();
    await page.getByRole("button", { name: "About Ali K" }).click();
    await expect(card.getByTestId("guest-invite")).toBeEnabled({ timeout: 30_000 });
    await card.getByTestId("guest-invite").click();
    await expect(card.getByTestId("guest-invite-invited")).toHaveText("Invited, waiting for an answer", { timeout: 20_000 });
    await expect(card).not.toContainText(LINK);
    await expectNoSideScroll(page);

    const inv = await db.one<{ origin: string; status: string }>(`SELECT origin, status FROM "ClubInvitation" WHERE "userId" = $1`, [ALI]);
    expect(inv).toEqual({ origin: "organiser", status: "open" });
    const dm = await db.one<{ text: string }>(`SELECT text FROM "PlatformJob" WHERE purpose = 'club-invite-ask' AND phone = '447700900991' ORDER BY "createdAt" DESC LIMIT 1`);
    expect(dm!.text).toMatch(/^\*E2E Test FC\* would like you to join their group/);
    expect(dm!.text).not.toContain(LINK);
  });
}

for (const [label, size] of SIZES) {
  test(`My invitations (${label}): his club invitation and his open game offer; Join sends the link by WhatsApp`, async ({ page, db }) => {
    await clearInvites(db);
    await setLink(db, LINK);
    await db.run(`INSERT INTO "ClubInvitation" (id,"orgId","userId","matchId",origin,"clubYesAt","updatedAt") VALUES ($1,$2,$3,$4,'organiser',now(),now())`, [`${P}-inv-${label}`, ORG_ID, ALI, MATCH.rate]);
    await db.run(`INSERT INTO "PoolAsk" (id,"matchId","orgId",places,via,status,"updatedAt") VALUES ($1,$2,$3,1,'page','open',now()) ON CONFLICT DO NOTHING`, [`${P}-ask`, MATCH.upcoming, ORG_ID]);
    await db.run(
      `INSERT INTO "PoolOffer" (id,"poolAskId","matchId","orgId","userId","distanceMiles","sentAt","expiresAt") VALUES ($1,$2,$3,$4,$5,1.2,now(),now() + interval '6 hours') ON CONFLICT DO NOTHING`,
      [`${P}-offer`, `${P}-ask`, MATCH.upcoming, ORG_ID, ALI],
    );
    await page.setViewportSize(size);
    await signInAs(page, ALI, "/play/invitations");
    const root = page.getByTestId("my-invitations");
    await expect(root.getByRole("heading", { level: 1 })).toHaveText("My invitations", { timeout: 30_000 });
    const inv = root.getByTestId("my-invitation");
    await expect(inv).toHaveCount(1);
    await expect(inv.getByTestId("my-invitation-club")).toHaveText("E2E Test FC");
    await expect(inv.getByTestId("my-invitation-sport")).toContainText("Football");
    await expect(inv.getByTestId("my-invitation-games")).toHaveText("You played 1 game with them.");
    const offer = root.getByTestId("my-offer");
    await expect(offer).toHaveCount(1);
    await expect(offer.getByTestId("my-offer-open")).toHaveAttribute("href", new RegExp(`^/play/offer/${P}-offer\\.`));
    await expect(root).not.toContainText(LINK);
    await expectNoSideScroll(page);

    await inv.getByTestId("my-invitation-join").click();
    await expect(inv.getByTestId("my-invitation-result")).toHaveText("Done. The invite link is on its way to you on WhatsApp.", { timeout: 20_000 });
    await expect(root).not.toContainText(LINK);
    const dm = await db.one<{ text: string }>(`SELECT text FROM "PlatformJob" WHERE purpose = 'club-invite-link' AND phone = '447700900991' ORDER BY "createdAt" DESC LIMIT 1`);
    expect(dm!.text).toContain(LINK);

    await page.reload();
    await expect(root.getByTestId("my-invitations-none")).toHaveText("No club invitations right now.", { timeout: 30_000 });
    await db.run(`DELETE FROM "PoolOffer" WHERE id = $1`, [`${P}-offer`]);
  });
}

test("My invitations: signed out goes to sign in; another player sees only his own (none)", async ({ page }) => {
  await page.goto("/play/invitations");
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await signInAs(page, U.player, "/play/invitations");
  await expect(page.getByTestId("my-invitations-none")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("my-offers-none")).toBeVisible();
  await expect(page.getByTestId("my-invitations")).not.toContainText("E2E Test FC");
});
