/**
 * /admin/health: the owner's dashboard of routine ops alerts.
 *
 * Kemal, 2026-09-28: stop the daily DMs and emails, "only put them into a
 * dashboard on the website where i can click and see whenever i want".
 * Two things must hold, and the second matters more:
 *
 *   1. the platform owner (`User.isSuperadmin`) sees every club's status
 *      and the recent alerts, in plain English;
 *   2. a club admin can NOT open it (404) and is not shown a link to it.
 *      It names other clubs and MatchTime's own plumbing.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

test.beforeEach(async ({ db }) => {
  await db.run(`DELETE FROM "OpsAlert"`);
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await db.run(`DELETE FROM "OpsAlert"`);
});

test("a club admin cannot open the health page and is not shown a link to it", async ({
  page,
}) => {
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  // The subnav has loaded (it fetches its badge and the owner flag).
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Let the owner-flag fetch settle, so "no Health link" is a real answer
  // and not a race against a request still in flight.
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: "Health", exact: true })).toHaveCount(0);

  const res = await page.goto("/admin/health");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("Current status")).toHaveCount(0);
  await expect(page.getByText("Recent alerts")).toHaveCount(0);
});

test("the platform owner sees each club's status and the recent alerts", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await db.run(
    `INSERT INTO "OpsAlert" (id, "orgId", kind, severity, title, detail, "firstSeenAt", "lastSeenAt", "resolvedAt")
     VALUES
       ('oa-open', $1, 'health:inbound-silent', 'warning',
        'No message from this group has reached MatchTime for 31 hours, with a match in 10 hours.',
        'The group may simply be quiet.', now() - interval '31 hours', now(), NULL),
       ('oa-closed', $1, 'health:sweep-stale', 'warning',
        'The group''s member list was last read 9 days ago.', 'Fixed by the Baileys move.',
        now() - interval '9 days', now() - interval '2 days', now() - interval '2 days'),
       ('oa-note', $1, 'operator-note', 'warning',
        '1 message routed to an action but nothing handled it',
        'Check the group and act manually if any were attendance changes.',
        now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours')`,
    [ORG_ID],
  );

  await signInAs(page, U.admin, "/admin/health");
  await page.waitForURL("**/admin/health");

  // Current status, one card per club with the bot on.
  await expect(page.getByText("Current status")).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId("club-status").filter({ hasText: "E2E Test FC" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Worth a look");
  await expect(card).toContainText("Group quiet before a match");

  // Recent alerts: all three, each with a plain English status.
  const rows = page.getByTestId("alert-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Group quiet before a match" })).toContainText(
    "Still happening",
  );
  await expect(rows.filter({ hasText: "Member list out of date" })).toContainText("Cleared");
  await expect(rows.filter({ hasText: "Message not handled" })).toContainText("One-off");

  // House style: no em or en dashes anywhere in the page's own copy.
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/[—–]/);

  // And the owner gets the link in the admin navigation.
  await expect(page.getByRole("link", { name: "Health", exact: true })).toBeVisible();
});

test("the owner sees an all-clear club as all good", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin/health");
  await page.waitForURL("**/admin/health");
  const card = page.getByTestId("club-status").filter({ hasText: "E2E Test FC" });
  await expect(card).toContainText("All good", { timeout: 30_000 });
  await expect(page.getByText(/Nothing has been flagged/)).toBeVisible();
});
