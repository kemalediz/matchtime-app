/**
 * "FINISH CONNECTING" MODE (2026-10-13), in a browser.
 *
 * Kemal: "the page should only show connect MT to Whatsapp panel as
 * without that nothing works and no point showing everything else ...
 * Let's say they do not press the button, leave the tab and come back
 * and login later, again this panel should be shown only to remind them."
 *
 *   - after creating a club, /admin is the connect panel and nothing else
 *     (no tabs, no stat tiles, no Manage buttons), with the club's name
 *     above it and the step it is on;
 *   - every other admin page, and the site's home, lead back to it;
 *   - ONE quiet link opens the club's details, where a rename still
 *     saves and the weekly game can still be opened;
 *   - signing out and in again with WhatsApp lands on the panel;
 *   - a pending club is still in the mode; an approved one is not;
 *   - an approved club's admin, a superadmin, and somebody who also runs
 *     an approved club see no change for that club.
 *
 * Rules: src/lib/connect-focus.ts. Deterministic: no model anywhere.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { E2E_BASE_URL } from "../helpers/env";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const ORGANISER = "e2e-cf-organiser";
const ORGANISER_PHONE = "+447700900971";
const CLUB = "Canal Street FC";
const RENAMED = "Canal Street Sevens";

async function flag(context: BrowserContext, on: boolean) {
  await context.addCookies([{ name: "mt-test-self-join", value: on ? "1" : "0", url: E2E_BASE_URL }]);
}

const club = (name: string) =>
  testDb().one<{ id: string; approvalStatus: string }>(`SELECT id, "approvalStatus" FROM "Organisation" WHERE name = $1`, [name]);

/** Nothing of the usual admin home is on the page. */
async function expectOnlyThePanel(page: Page) {
  await expect(page.getByTestId("connect-focus-panel")).toBeVisible();
  await expect(page.getByTestId("club-connect-card")).toBeVisible();
  const main = page.locator("main");
  // The tabs.
  for (const tab of ["Activities", "Block bookings", "Players", "Unresolved", "Stats", "Roster check-in", "Organisations", "Settings"]) {
    await expect(main.getByRole("link", { name: tab, exact: true }), `tab ${tab}`).toHaveCount(0);
  }
  // The stat tiles and the buttons.
  await expect(main.getByText("Upcoming", { exact: true })).toHaveCount(0);
  await expect(main.getByText("Completed", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("link", { name: /Manage activities/ })).toHaveCount(0);
  await expect(main.getByRole("link", { name: /Manage players/ })).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Org settings" })).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Admin", exact: true })).toHaveCount(0);
}

/** The usual admin home: tabs, tiles and buttons. */
async function expectTheFullDashboard(page: Page) {
  const main = page.locator("main");
  await expect(main.getByRole("link", { name: "Players", exact: true }).first()).toBeVisible();
  await expect(main.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await expect(main.getByText("Upcoming", { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: /Manage activities/ })).toBeVisible();
  await expect(page.getByTestId("connect-focus-panel")).toHaveCount(0);
  await expect(page.getByTestId("connect-focus")).toHaveCount(0);
}

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  // A user whose phone was verified by a WhatsApp code, with no club.
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt")
     VALUES ($1,'Cem Organiser',$2,$3,true,true,now())`,
    [ORGANISER, `${ORGANISER}@e2e.local`, ORGANISER_PHONE],
  );
  await db.run(
    `INSERT INTO "PhoneOtp" (id, phone, code, "expiresAt", "usedAt", attempts, "createdAt")
     VALUES ($1,$2,'123456',now(),now(),0,now())`,
    [`${ORGANISER}-otp`, ORGANISER_PHONE.slice(1)],
  );
});

test.afterAll(() => {
  resetDb();
});

test("after creating a club, /admin is the connect panel and nothing else", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, ORGANISER, "/create-org");
  await expect(page.getByRole("heading", { name: "Set up your club" })).toBeVisible();
  await page.getByLabel("Club name").fill(CLUB);
  await page.getByLabel("Day", { exact: true }).selectOption({ label: "Tuesday" });
  await page.getByLabel("Kick-off time").fill("20:00");
  await page.getByLabel("Venue", { exact: true }).fill("Canal Street Pitches");
  await page.getByRole("button", { name: "Create club" }).click();

  await page.waitForURL("**/admin", { timeout: 30_000 });
  expect((await club(CLUB))?.approvalStatus).toBe("draft");

  await expectOnlyThePanel(page);
  await expect(page.getByTestId("connect-focus-club")).toHaveText(CLUB);
  await expect(page.getByTestId("connect-focus-lead")).toHaveText(
    "MatchTime can't do anything for your club until it is connected to your WhatsApp group. That is the one thing to do now.",
  );
  const card = page.getByTestId("club-connect-card");
  await expect(card).toHaveAttribute("data-state", "draft");
  await expect(page.getByTestId("club-connect-step")).toHaveText("Step 1 of 3");
  // One thing to do, one button.
  await expect(page.getByTestId("club-connect-button")).toHaveText("Add MatchTime to WhatsApp");
  await expect(page.locator("main").getByRole("button")).toHaveCount(2); // the button and the card's info popup
  await expect(page.getByTestId("connect-focus-edit")).toHaveText("Edit club details");

  // The sidebar: Dashboard and Matches are left out, the rest stays.
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Admin" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Profile" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Help" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Matches" })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("every other admin page, and the home page, lead back to the panel", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, ORGANISER, "/admin");

  // On the server, before anything of the page is sent.
  for (const p of ["/admin/players", "/admin/stats", "/admin/block-bookings", "/admin/unresolved", "/admin/matches/x/teams", "/"]) {
    const res = await page.request.get(p, { maxRedirects: 0 });
    expect(res.status(), p).toBe(307);
    expect(new URL(res.headers().location, E2E_BASE_URL).pathname, p).toBe("/admin");
  }

  // In a browser.
  for (const p of ["/admin/players", "/admin/stats", "/admin/roster-survey", "/admin/organisations", "/"]) {
    await page.goto(p);
    await page.waitForURL((url) => url.pathname === "/admin");
    await expectOnlyThePanel(page);
  }

  // Moving between admin pages WITHOUT a full load (the layout is not
  // rendered again, so the gate in it decides): still back to the panel.
  await page.goto("/admin/settings");
  await expect(page.getByTestId("connect-focus-back")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router.push("/admin/players");
  });
  await page.waitForURL((url) => url.pathname === "/admin");
  await expectOnlyThePanel(page);
});

test("the edit link: the club's details open without the tabs, a rename saves, the weekly game opens", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, ORGANISER, "/admin");
  await page.getByTestId("connect-focus-edit").click();
  await page.waitForURL("**/admin/settings");

  const main = page.locator("main");
  await expect(page.getByTestId("connect-focus")).toHaveAttribute("data-view", "edit");
  await expect(page.getByTestId("connect-focus-back")).toHaveText("Back to connecting MatchTime");
  // No tabs to anywhere else: only the two edit pages.
  await expect(page.getByTestId("connect-focus-edit-nav").getByRole("link")).toHaveText(["Club name and settings", "Weekly game"]);
  for (const tab of ["Players", "Stats", "Unresolved", "Block bookings", "Organisations"]) {
    await expect(main.getByRole("link", { name: tab, exact: true }), `tab ${tab}`).toHaveCount(0);
  }

  // A rename still saves (PR #226).
  const name = page.getByLabel("Organisation name", { exact: true });
  await expect(name).toBeEnabled({ timeout: 30_000 });
  await expect(name).toHaveValue(CLUB);
  await name.fill(RENAMED);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByTestId("club-name-saved")).toBeVisible({ timeout: 30_000 });
  expect((await club(RENAMED))?.approvalStatus).toBe("draft");
  expect(await club(CLUB)).toBeNull();

  // The weekly game they typed at sign-up.
  await page.getByTestId("connect-focus-edit-nav").getByRole("link", { name: "Weekly game" }).click();
  await page.waitForURL("**/admin/activities");
  await expect(page.getByTestId("connect-focus")).toHaveAttribute("data-view", "edit");
  await expect(main.getByText("Canal Street Pitches").first()).toBeVisible({ timeout: 30_000 });
  await expect(main.getByRole("link", { name: "Players", exact: true })).toHaveCount(0);

  // And back to the one thing to do, under the new name.
  await page.getByTestId("connect-focus-back").click();
  await page.waitForURL((url) => url.pathname === "/admin");
  await expectOnlyThePanel(page);
  await expect(page.getByTestId("connect-focus-club")).toHaveText(RENAMED);
});

test("signing out, then in again with WhatsApp, lands on the panel", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, ORGANISER, "/admin");
  await page.locator("aside").getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login**");

  // No callbackUrl: exactly where a returning organiser starts.
  await flag(context, true);
  await page.goto("/login");
  await page.getByLabel("Phone number").fill(ORGANISER_PHONE);
  await page.getByRole("button", { name: "Sign in with WhatsApp" }).click();
  await expect(page.getByLabel("6 digit code")).toBeVisible();
  const otp = await testDb().one<{ code: string }>(
    `SELECT code FROM "PhoneOtp" WHERE phone = $1 AND "usedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`,
    [ORGANISER_PHONE.slice(1)],
  );
  await page.getByLabel("6 digit code").fill(otp!.code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await page.waitForURL((url) => url.pathname === "/admin", { timeout: 30_000 });
  await expectOnlyThePanel(page);
  await expect(page.getByTestId("connect-focus-club")).toHaveText(RENAMED);
  await expect(page.getByTestId("club-connect-button")).toBeVisible();
});

test("a club waiting for approval is still in the mode, on step 3", async ({ page, context }) => {
  const db = testDb();
  await flag(context, true);
  const org = (await club(RENAMED))!;
  await db.run(
    `INSERT INTO "ClubConnect" (id, "orgId", "userId", phone, code, status, "issuedAt", "expiresAt", "groupId", "groupSubject", "adderMatch", "linkedAt", "updatedAt")
     VALUES ('e2e-cf-cc',$1,$2,$3,'7KQ2','group_linked',now(),now(),'120363900000000971@g.us','Canal Street Tuesdays','phone',now(),now())`,
    [org.id, ORGANISER, ORGANISER_PHONE.slice(1)],
  );
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'pending' WHERE id = $1`, [org.id]);

  await signInAs(page, ORGANISER, "/admin");
  await expectOnlyThePanel(page);
  await expect(page.getByTestId("club-connect-card")).toHaveAttribute("data-state", "pending");
  await expect(page.getByTestId("club-connect-step")).toHaveText("Step 3 of 3");
  await expect(page.getByTestId("connect-focus-lead")).toHaveText(
    "Nothing more for you to do right now. The rest of your club's pages open here as soon as your club is approved.",
  );
  await expect(page.getByTestId("club-connect-button")).toHaveCount(0);

  await page.goto("/admin/players");
  await page.waitForURL((url) => url.pathname === "/admin");
});

test("in Turkish, for a Turkish club", async ({ page, context }) => {
  const db = testDb();
  await flag(context, true);
  const org = (await club(RENAMED))!;
  await db.run(`UPDATE "Organisation" SET language = 'tr', "approvalStatus" = 'draft' WHERE id = $1`, [org.id]);
  await db.run(`DELETE FROM "ClubConnect" WHERE "orgId" = $1`, [org.id]);

  await signInAs(page, ORGANISER, "/admin");
  await expect(page.getByTestId("connect-focus-lead")).toHaveText(
    "MatchTime, WhatsApp grubunuza bağlanana kadar kulübünüz için hiçbir şey yapamaz. Şu an yapılacak tek şey bu.",
  );
  await expect(page.getByTestId("club-connect-step")).toHaveText("1. adım, toplam 3 adım");
  await expect(page.getByTestId("connect-focus-edit")).toHaveText("Kulüp bilgilerini düzenle");
  await page.getByTestId("connect-focus-edit").click();
  await page.waitForURL("**/admin/settings");
  await expect(page.getByTestId("connect-focus-back")).toHaveText("MatchTime'ı bağlamaya dön");
  await expect(page.getByTestId("connect-focus-edit-nav").getByRole("link")).toHaveText(["Kulüp adı ve ayarlar", "Haftalık maç"]);

  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [org.id]);
});

test("once the club is approved, everything shows as it always did", async ({ page, context }) => {
  const db = testDb();
  await flag(context, true);
  const org = (await club(RENAMED))!;

  // The organiser is looking at the pending panel when the decision lands.
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'pending' WHERE id = $1`, [org.id]);
  await signInAs(page, ORGANISER, "/admin");
  await expectOnlyThePanel(page);

  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = now() WHERE id = $1`, [org.id]);
  await page.goto("/admin");
  await expectTheFullDashboard(page);
  await expect(page.locator("main").getByRole("heading", { name: "Admin", exact: true })).toBeVisible();
  // The card is back to being one card among the rest, with no step.
  await expect(page.getByTestId("club-connect-card")).toHaveAttribute("data-state", "approved");
  await expect(page.getByTestId("club-connect-step")).toHaveCount(0);

  // The other pages open, and the home page is the dashboard again.
  await page.goto("/admin/players");
  await expect(page).toHaveURL(/\/admin\/players$/);
  await expect(page.locator("main").getByRole("link", { name: "Players", exact: true })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`^${E2E_BASE_URL}/?$`));
  await expect(page.getByText(`Here's what's happening at ${RENAMED}.`)).toBeVisible();
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Matches" })).toBeVisible();
});

test("an approved club's admin sees no change, with self-join on", async ({ page, context }) => {
  await flag(context, true);
  await signInAs(page, U.admin, "/admin");
  await expectTheFullDashboard(page);
  await page.goto("/admin/players");
  await expect(page).toHaveURL(/\/admin\/players$/);
  await page.goto("/");
  await expect(page.getByText(/Here's what's happening at/)).toBeVisible();
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Matches" })).toBeVisible();
});

test("somebody who runs an approved club and owns a draft one: the mode follows the club they have selected", async ({
  page,
  context,
}) => {
  const db = testDb();
  await flag(context, true);
  const approved = (await db.one<{ id: string; name: string }>(
    `SELECT o.id, o.name FROM "Organisation" o JOIN "Membership" m ON m."orgId" = o.id WHERE m."userId" = $1 ORDER BY m."createdAt" LIMIT 1`,
    [U.admin],
  ))!;
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "approvalStatus", "createdAt", "updatedAt")
     VALUES ('e2e-cf-second','Second Draft FC','e2e-cf-second','e2e-cf-second-invite','draft',now(),now())`,
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ('e2e-cf-second-m',$1,'e2e-cf-second','OWNER')`, [U.admin]);

  // Their approved club is the selected one: nothing changes.
  await context.addCookies([{ name: "orgId", value: approved.id, url: E2E_BASE_URL }]);
  await signInAs(page, U.admin, "/admin");
  await expectTheFullDashboard(page);
  await page.goto("/admin/players");
  await expect(page).toHaveURL(/\/admin\/players$/);

  // They pick the draft club in the sidebar: the panel.
  await page.goto("/admin");
  await page.locator("aside").getByRole("button", { name: new RegExp(approved.name) }).click();
  await page.locator("aside").getByRole("button", { name: /Second Draft FC/ }).click();
  await expect(page.getByTestId("connect-focus-club")).toHaveText("Second Draft FC");
  await expectOnlyThePanel(page);
  await page.goto("/admin/players");
  await page.waitForURL((url) => url.pathname === "/admin");

  // And back to the approved one: its pages again.
  await page.locator("aside").getByRole("button", { name: /Second Draft FC/ }).click();
  await page.locator("aside").getByRole("button", { name: new RegExp(approved.name) }).click();
  await expectTheFullDashboard(page);
  await page.goto("/admin/players");
  await expect(page).toHaveURL(/\/admin\/players$/);

  // A superadmin who owns a draft club keeps the full admin area (they
  // approve clubs from the Clubs tab).
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await context.addCookies([{ name: "orgId", value: "e2e-cf-second", url: E2E_BASE_URL }]);
  await page.goto("/admin");
  await expectTheFullDashboard(page);
  await expect(page.locator("main").getByRole("link", { name: "Clubs", exact: true })).toBeVisible();
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);

  // With self-join switched off the card is not drawn, so neither is the mode.
  await flag(context, false);
  await page.goto("/admin");
  await expectTheFullDashboard(page);
});
