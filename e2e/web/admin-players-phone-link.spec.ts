/**
 * Admin → Players: a phone number that belongs to a player at another
 * club (FNF incident 2026-10-18).
 *
 * The club's OWNER (Alex Admin, who has NO role at the other club) types
 * the number of "Habib Rahman", a Sutton Lenders player, onto the club's
 * phoneless "Habib":
 *
 *   - the page asks "same person?" with the first name and the other
 *     club's name only, never the raw Server Components error;
 *   - "No" keeps the number unsaved and says why;
 *   - the same question in Turkish for a Turkish club;
 *   - "Yes" links them: this club's Habib is merged INTO the existing
 *     account (its id and phone stay), which now has both memberships and
 *     this club's attendance and seed; nothing at the other club changes;
 *     the audit row names who linked.
 *
 * And #314's account guard holds alongside it:
 *
 *   - a club record somebody signed in on is refused before any question;
 *   - the link never fills the existing account's global name or image;
 *   - after the link the existing account is not this club's to edit.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const OTHER = "e2e-xc-sutton";
const KEEP = "e2e-xc-habib-sutton";
const DROP = "e2e-xc-habib-fnf";
const PHONE = "+447404111243";

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt") VALUES ($1,'Sutton Lenders',$1,$2,'approved',now(),now())`,
    [OTHER, `${OTHER}-invite`],
  );
  // The existing account at the other club.
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Habib Rahman','wa-447404111243@placeholder.matchtime',$2,false,true,now())`,
    [KEEP, PHONE],
  );
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"seedRating","matchRating","createdAt") VALUES ('e2e-xc-m-keep',$1,$2,'PLAYER',9,1234,now())`,
    [KEEP, OTHER],
  );
  await db.run(`INSERT INTO "UserAlias" (id,"userId","orgId",alias,source) VALUES ('e2e-xc-alias-b',$1,$2,'habo','manual')`, [KEEP, OTHER]);
  // This club's phoneless placeholder, pasted from a list.
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Habib','manual-e2exc-1@placeholder.matchtime',NULL,false,true,now())`,
    [DROP],
  );
  await db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"seedRating","createdAt") VALUES ('e2e-xc-m-drop',$1,$2,'PLAYER',7,now())`,
    [DROP, ORG_ID],
  );
  await db.run(
    `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ('e2e-xc-att',$1,$2,'BENCH',11,now(),now())`,
    [MATCH.upcoming, DROP],
  );
});

test.afterAll(() => {
  resetDb();
});

function habibPhone(page: import("@playwright/test").Page) {
  return page
    .locator("div")
    .filter({ has: page.locator('input[value="Habib"]') })
    .filter({ has: page.locator('input[type="tel"]') })
    .last()
    .locator('input[type="tel"]');
}

test("the admin is asked 'same person?' with the first name and club only, and No keeps it unsaved", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/players");
  await expect(page.locator('input[value="Habib"]')).toBeVisible({ timeout: 30_000 });
  const usersBefore = await db.count(`SELECT COUNT(*) FROM "User"`);

  const input = habibPhone(page);
  await input.fill("+44 7404 111243");
  await input.press("Enter");

  const dialog = page.getByTestId("phone-link-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("Same person?", { exact: true })).toBeVisible();
  await expect(page.getByTestId("phone-link-question")).toHaveText(
    "This number belongs to Habib, who plays at Sutton Lenders. Same person?",
  );
  // Nothing else of the other club's player: no surname, no rating, no alias.
  const dialogText = await dialog.innerText();
  expect(dialogText).not.toContain("Rahman");
  expect(dialogText).not.toContain("habo");
  expect(dialogText).not.toMatch(/\b9\b|1234/);
  expect(dialogText).not.toMatch(/[–—]/);
  await expect(page.getByText(/Server Components render/)).toHaveCount(0);

  await dialog.getByRole("button", { name: "No, it's a different number" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Not saved. That number already belongs to someone else and can't be used twice.")).toBeVisible();
  await expect(input).toHaveValue("");

  expect(await db.count(`SELECT COUNT(*) FROM "User"`)).toBe(usersBefore);
  const drop = await db.one<{ phone: string | null }>(`SELECT "phoneNumber" AS phone FROM "User" WHERE id = $1`, [DROP]);
  expect(drop?.phone).toBeNull();
});

test("a record somebody signed in on is refused before any 'same person?' question (#314)", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET onboarded = true WHERE id = $1`, [DROP]);
  try {
    await signInAs(page, U.admin, "/admin/players");
    await expect(page.locator('input[value="Habib"]')).toBeVisible({ timeout: 30_000 });
    const input = habibPhone(page);
    await input.fill(PHONE);
    await input.press("Enter");
    await expect(
      page.getByText("This player manages their own number and name on MatchTime, so only they can change them."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("phone-link-dialog")).toHaveCount(0);
    const drop = await db.one<{ phone: string | null }>(`SELECT "phoneNumber" AS phone FROM "User" WHERE id = $1`, [DROP]);
    expect(drop?.phone).toBeNull();
  } finally {
    await db.run(`UPDATE "User" SET onboarded = false WHERE id = $1`, [DROP]);
  }
});

test("a Turkish club gets the question in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await signInAs(page, U.admin, "/admin/players");
    await expect(page.locator('input[value="Habib"]')).toBeVisible({ timeout: 30_000 });
    const input = habibPhone(page);
    await input.fill(PHONE);
    await input.press("Enter");
    const dialog = page.getByTestId("phone-link-dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("phone-link-question")).toHaveText(
      "Bu numara Sutton Lenders kulübünde oynayan Habib adlı kişiye ait. Aynı kişi mi?",
    );
    await expect(dialog.getByRole("button", { name: "Evet, bağla" })).toBeVisible();
    await dialog.getByRole("button", { name: "Hayır, farklı bir numara" }).click();
    await expect(page.getByText("Kaydedilmedi. Bu numara zaten başka birine ait ve iki kez kullanılamaz.")).toBeVisible();
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("Yes links them: this club's data moves onto the existing account, the other club is untouched", async ({ page, db }) => {
  // The placeholder has a picture the existing account lacks. User.image
  // is global, so the link must not copy it across (#314).
  await db.run(`UPDATE "User" SET image = 'https://example.test/drop.png' WHERE id = $1`, [DROP]);
  await db.run(`UPDATE "User" SET image = NULL WHERE id = $1`, [KEEP]);
  await signInAs(page, U.admin, "/admin/players");
  await expect(page.locator('input[value="Habib"]')).toBeVisible({ timeout: 30_000 });

  const input = habibPhone(page);
  await input.fill(PHONE);
  await input.press("Enter");
  const dialog = page.getByTestId("phone-link-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Yes, link them" }).click();
  await expect(page.getByText("Linked to their existing account.")).toBeVisible({ timeout: 30_000 });

  // The placeholder is gone; the existing account keeps its id and phone.
  await expect.poll(async () => db.count(`SELECT COUNT(*) FROM "User" WHERE id = $1`, [DROP])).toBe(0);
  const keep = await db.one<{ phone: string; name: string; image: string | null }>(
    `SELECT "phoneNumber" AS phone, name, image FROM "User" WHERE id = $1`,
    [KEEP],
  );
  expect(keep).toEqual({ phone: PHONE, name: "Habib Rahman", image: null });

  // Both memberships; this club's carries this club's seed.
  const mA = await db.one<{ seed: number; role: string }>(
    `SELECT "seedRating" AS seed, role FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [KEEP, ORG_ID],
  );
  expect(mA).toEqual({ seed: 7, role: "PLAYER" });
  // The other club's membership and alias are exactly as they were.
  const mB = await db.one<{ id: string; seed: number; elo: number; role: string; left: Date | null }>(
    `SELECT id, "seedRating" AS seed, "matchRating" AS elo, role, "leftAt" AS left FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`,
    [KEEP, OTHER],
  );
  expect(mB).toEqual({ id: "e2e-xc-m-keep", seed: 9, elo: 1234, role: "PLAYER", left: null });
  expect(await db.count(`SELECT COUNT(*) FROM "UserAlias" WHERE "orgId" = $1`, [OTHER])).toBe(1);
  expect(await db.count(`SELECT COUNT(*) FROM "UserAlias" WHERE id = 'e2e-xc-alias-b' AND "userId" = $1 AND alias = 'habo'`, [KEEP])).toBe(1);

  // This club's attendance moved onto the existing account.
  const att = await db.one<{ uid: string }>(`SELECT "userId" AS uid FROM "Attendance" WHERE id = 'e2e-xc-att'`);
  expect(att?.uid).toBe(KEEP);

  // The audit row: who linked whom, scoped to this club.
  const audit = await db.one<{ orgId: string; actor: string; reason: string }>(
    `SELECT "orgId", "actorUserId" AS actor, reason FROM "UserMerge" WHERE "oldUserId" = $1 AND "survivorUserId" = $2`,
    [DROP, KEEP],
  );
  expect(audit).toEqual({ orgId: ORG_ID, actor: U.admin, reason: "cross-club-phone-link" });
  expect(await db.count(`SELECT COUNT(*) FROM "UserMerge" WHERE "oldUserId" = $1 AND "orgId" <> $2`, [DROP, ORG_ID])).toBe(0);

  // The row on the page now is the linked account, with the number.
  await expect(page.locator('input[value="Habib Rahman"]')).toBeVisible({ timeout: 15_000 });

  // #314 still holds: the linked account belongs to another club too, so
  // this club cannot change its number.
  const linked = page
    .locator("div")
    .filter({ has: page.locator('input[value="Habib Rahman"]') })
    .filter({ has: page.locator('input[type="tel"]') })
    .last()
    .locator('input[type="tel"]');
  await linked.fill("+447700900777");
  await linked.press("Enter");
  await expect(
    page.getByText("This player manages their own number and name on MatchTime, so only they can change them."),
  ).toBeVisible({ timeout: 15_000 });
  const after = await db.one<{ phone: string }>(`SELECT "phoneNumber" AS phone FROM "User" WHERE id = $1`, [KEEP]);
  expect(after?.phone).toBe(PHONE);
});
