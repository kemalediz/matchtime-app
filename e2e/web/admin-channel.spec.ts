/**
 * /admin/settings, Messages tab, "Admin messages" → "Admin messages go to"
 * (slice 2a; its own card since 2026-10-28, opened here by its link).
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
  await signInAs(page, U.admin, "/admin/settings#admin-group");
  const section = page.getByTestId("admin-channel-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText("Admin messages go to", { exact: true })).toBeVisible();
  await expect(section.getByLabel("Each admin by DM")).toBeChecked();

  await section.getByRole("button", { name: "What is Admin messages go to?" }).click();
  await expect(page.getByRole("dialog")).toContainText("Where MatchTime sends the messages only organisers should see");
  await page.getByRole("button", { name: "Close" }).click();

  await section.getByLabel("One person").check();
  await expect.poll(async () => (await mode(db))?.adminChannelMode).toBe("one-person");
  await section.locator("#admin-channel-person").selectOption(U.collector);
  await expect.poll(async () => (await mode(db))?.adminChannelUserId).toBe(U.collector);
});

test("Admin WhatsApp group: code and steps, linked by the command, then Unlink", async ({ page, db, request }) => {
  await signInAs(page, U.admin, "/admin/settings#admin-group");
  const section = page.getByTestId("admin-channel-section");
  await expect(section).toBeVisible({ timeout: 30_000 });

  await section.getByLabel("Admin WhatsApp group").check();
  // Not saved until a group is linked.
  await expect(section.getByText(/Until a group is linked/)).toBeVisible();
  expect((await mode(db))?.adminChannelMode).toBe("one-person");

  await section.getByRole("button", { name: "Link admin group", exact: true }).click();
  const steps = section.getByTestId("admin-group-steps");
  await expect(steps).toBeVisible();
  await expect(steps).toContainText(/Your code: [ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}/);
  await expect(steps).toContainText("Add MatchTime to your admins' WhatsApp group.");
  const code = (await db.one<{ c: string }>(`SELECT "adminGroupLinkCode" AS c FROM "Organisation" WHERE id = $1`, [ORG_ID]))!.c;
  await expect(steps).toContainText("tag me (type @Match Time and pick me from the list) and send the code:");
  await expect(steps).toContainText(`@Match Time ${code}`);

  // The organiser adds MatchTime to the HQ group, tags it and sends the code.
  await request.post("/api/whatsapp/bot-added", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { groupId: HQ, groupSubject: "E2E HQ", addedByPhone: PHONE.admin.replace(/^\+/, ""), participants: [] },
  });
  const linked = await request.post("/api/whatsapp/admin-group-link", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: { groupId: HQ, text: `@447700900000 ${code}`, botMentioned: true, senderPhone: PHONE.admin.replace(/^\+/, "") },
  });
  expect((await linked.json()).outcome).toBe("linked");

  // The page was polling: it shows the linked group.
  await expect(section.getByTestId("admin-group-linked")).toHaveText("Linked: E2E HQ", { timeout: 20_000 });
  expect((await mode(db))?.adminChannelMode).toBe("admin-group");

  await section.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect.poll(async () => (await mode(db))?.adminGroupId).toBeNull();
  await expect(section.getByLabel("One person")).toBeChecked();
  const leave = await db.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM "PlatformJob" WHERE kind = 'leave-group' AND "groupId" = $1`,
    [HQ],
  );
  expect(leave?.n).toBe("1");
});

test("a code MatchTime already sent by DM is SHOWN with its real expiry, not replaced; 'New code' replaces it", async ({ page, db }) => {
  // The code from a setup DM: open, six days left.
  await db.run(
    `UPDATE "Organisation" SET "adminGroupLinkCode" = 'K7P3QX', "adminGroupLinkCodeExpiresAt" = (now() AT TIME ZONE 'UTC') + interval '6 days'
      WHERE id = $1`,
    [ORG_ID],
  );
  const stored = () =>
    db.one<{ c: string | null; left: number }>(
      `SELECT "adminGroupLinkCode" AS c,
              EXTRACT(EPOCH FROM ("adminGroupLinkCodeExpiresAt" - (now() AT TIME ZONE 'UTC')))::float AS left
         FROM "Organisation" WHERE id = $1`,
      [ORG_ID],
    );
  try {
    await signInAs(page, U.admin, "/admin/settings#admin-group");
    const section = page.getByTestId("admin-channel-section");
    await expect(section).toBeVisible({ timeout: 30_000 });
    await section.getByLabel("Admin WhatsApp group").check();

    // The same code and command, at once, with no button pressed.
    const steps = section.getByTestId("admin-group-steps");
    await expect(steps).toContainText("Your code: K7P3QX");
    await expect(steps).toContainText("@Match Time K7P3QX");
    // Its real expiry, not "48 hours".
    const note = section.getByTestId("admin-group-code-note");
    await expect(note).toContainText(/The code works once and is valid until \w+ \d{1,2} \w+ at \d{2}:\d{2}\./);
    await expect(note).not.toContainText("48 hours");
    // While a code is on screen the button is "New code": nothing replaces it by accident.
    await expect(section.getByRole("button", { name: "Link admin group", exact: true })).toHaveCount(0);
    expect((await stored())?.c).toBe("K7P3QX");
    expect((await stored())!.left).toBeGreaterThan(5.9 * 24 * 3600);

    // The organiser asks for a new one: replaced, valid 48 hours.
    await section.getByRole("button", { name: "New code", exact: true }).click();
    await expect.poll(async () => (await stored())?.c).not.toBe("K7P3QX");
    const fresh = (await stored())!;
    expect(fresh.c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(fresh.left).toBeGreaterThan(47.9 * 3600);
    expect(fresh.left).toBeLessThanOrEqual(48 * 3600);
    await expect(steps).toContainText(`Your code: ${fresh.c}`);
  } finally {
    await db.run(`UPDATE "Organisation" SET "adminGroupLinkCode" = NULL, "adminGroupLinkCodeExpiresAt" = NULL WHERE id = $1`, [ORG_ID]);
  }
});

test("in Turkish for a Turkish club", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await signInAs(page, U.admin, "/admin/settings#admin-group");
    const section = page.getByTestId("admin-channel-section");
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.getByText("Yönetici mesajları", { exact: true })).toBeVisible();
    await expect(section.getByLabel("Her yöneticiye DM")).toBeVisible();
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});
