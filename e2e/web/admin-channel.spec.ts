/**
 * /admin/settings, "Weekly routine" → "Admin messages go to" (slice 2a).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.3 and 5.
 *
 *   - the ⓘ explains it, in the club's language;
 *   - "One person" persists (the owner by default, or a chosen admin);
 *   - "Admin WhatsApp group" does not take effect before a group is linked:
 *     it shows "Link admin group", then the code and the three steps, then
 *     "Linked: <group>" once the command arrives, and Unlink.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID, PHONE } from "../helpers/constants";
import { E2E } from "../helpers/env";

test.describe.configure({ mode: "serial" });

const HQ = "120363777000000011@g.us";

test.beforeAll(async ({ db }) => {
  resetDb();
  // A second admin with a phone, for the person picker.
  await db.run(`UPDATE "Membership" SET role = 'ADMIN' WHERE "orgId" = $1 AND "userId" = $2`, [ORG_ID, U.collector]);
});

test.afterAll(() => {
  resetDb();
});

const mode = async (db: import("../helpers/test-db").TestDb) =>
  db.one<{ adminChannelMode: string; adminChannelUserId: string | null; adminGroupId: string | null }>(
    `SELECT "adminChannelMode","adminChannelUserId","adminGroupId" FROM "Organisation" WHERE id = $1`,
    [ORG_ID],
  );

test("the section and its ⓘ, and One person persists", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const section = page.getByTestId("admin-channel-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText("Admin messages go to", { exact: true })).toBeVisible();
  await expect(section.getByLabel("Each admin by DM")).toBeChecked();

  await section.getByRole("button", { name: "What is Admin messages go to?" }).click();
  await expect(page.getByText(/Where MatchTime sends messages only admins should see/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await section.getByLabel("One person").check();
  await expect.poll(async () => (await mode(db))?.adminChannelMode).toBe("one-person");
  await section.locator("#admin-channel-person").selectOption(U.collector);
  await expect.poll(async () => (await mode(db))?.adminChannelUserId).toBe(U.collector);
});

test("Admin WhatsApp group: code and steps, linked by the command, then Unlink", async ({ page, db, request }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const section = page.getByTestId("admin-channel-section");
  await expect(section).toBeVisible({ timeout: 30_000 });

  await section.getByLabel("Admin WhatsApp group").check();
  // Not saved until a group is linked.
  await expect(section.getByText(/Until a group is linked/)).toBeVisible();
  expect((await mode(db))?.adminChannelMode).toBe("one-person");

  await section.getByRole("button", { name: "Link admin group" }).click();
  const steps = section.getByTestId("admin-group-steps");
  await expect(steps).toBeVisible();
  await expect(steps).toContainText(/Your code: [ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}/);
  await expect(steps).toContainText("Add MatchTime to your admins' WhatsApp group.");
  const code = (await db.one<{ c: string }>(`SELECT "adminGroupLinkCode" AS c FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.c;
  await expect(steps).toContainText(`@Match Time admin group ${code}`);

  // The organiser adds MatchTime to the HQ group and sends the command.
  await request.post("/api/whatsapp/bot-added", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { groupId: HQ, groupSubject: "E2E HQ", addedByPhone: PHONE.admin.replace(/^\+/, ""), participants: [] },
  });
  const linked = await request.post("/api/whatsapp/admin-group-link", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { groupId: HQ, text: `@Match Time admin group ${code}`, senderPhone: PHONE.admin.replace(/^\+/, "") },
  });
  expect((await linked.json()).outcome).toBe("linked");

  // The page was polling: it shows the linked group.
  await expect(section.getByTestId("admin-group-linked")).toHaveText("Linked: E2E HQ", { timeout: 20_000 });
  expect((await mode(db))?.adminChannelMode).toBe("admin-group");

  await section.getByRole("button", { name: "Unlink" }).click();
  await expect.poll(async () => (await mode(db))?.adminGroupId).toBeNull();
  await expect(section.getByLabel("One person")).toBeChecked();
  const leave = await db.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = $1`,
    [HQ],
  );
  expect(leave?.n).toBe("1");
});

test("in Turkish for a Turkish club", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await signInAs(page, U.admin, "/admin/settings");
    const section = page.getByTestId("admin-channel-section");
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.getByText("Yönetici mesajları", { exact: true })).toBeVisible();
    await expect(section.getByLabel("Her yöneticiye DM")).toBeVisible();
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});
