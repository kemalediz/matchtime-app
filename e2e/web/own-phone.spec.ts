/**
 * /welcome and /profile never wipe a player's own number (FNF 2026-10-18).
 *
 * Feroz was created by the bot with his number, opened /welcome, left the
 * optional phone field blank, and his number became NULL: no more WhatsApp
 * sign-in, no more DMs. Now a stored number is shown read-only (it is the
 * sign-in number) and the form never sends it; a player with none may add
 * one nobody else holds.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { PHONE } from "../helpers/constants";

const phoneOf = async (db: { one: <T>(sql: string, p: unknown[]) => Promise<T | null> }, id: string) =>
  (await db.one<{ phoneNumber: string | null; onboarded: boolean; name: string }>(
    `SELECT "phoneNumber", onboarded, name FROM "User" WHERE id = $1`,
    [id],
  ))!;

test.beforeEach(() => {
  resetDb();
});

test("welcome: a not-onboarded player sees their number read-only and keeps it (the Feroz case)", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET onboarded = false WHERE id = $1`, [U.player]);
  await signInAs(page, U.player);
  await page.waitForURL("**/welcome", { timeout: 30_000 });

  const phone = page.getByLabel("Phone number");
  await expect(phone).toHaveValue(PHONE.player);
  await expect(phone).not.toBeEditable();
  await expect(page.getByTestId("phone-signin-note")).toHaveText(
    "This is the number you sign in with, so it can't be changed here.",
  );

  await page.getByLabel("Your name").fill("Pat Player");
  await page.getByRole("button", { name: "Complete setup" }).click();
  await page.waitForURL((url) => url.pathname !== "/welcome", { timeout: 30_000 });

  const row = await phoneOf(db, U.player);
  expect(row.phoneNumber).toBe(PHONE.player);
  expect(row.onboarded).toBe(true);
});

test.describe("in Turkish", () => {
  test.use({ locale: "tr-TR" });
  test("welcome: the sign-in note reads in Turkish", async ({ page, db }) => {
    await db.run(`UPDATE "User" SET onboarded = false WHERE id = $1`, [U.player]);
    await signInAs(page, U.player);
    await page.waitForURL("**/welcome", { timeout: 30_000 });
    await expect(page.getByTestId("phone-signin-note")).toHaveText(
      "Giriş yaptığın numara bu, bu yüzden burada değiştirilemez.",
    );
    await expect(page.getByRole("button", { name: "Kurulumu tamamla" })).toBeVisible();
  });
});

test("welcome: a player with no number may add a free one, never somebody else's", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET onboarded = false WHERE id = $1`, [U.guest]);
  await signInAs(page, U.guest, "/welcome");
  await page.waitForURL("**/welcome", { timeout: 30_000 });

  const phone = page.getByLabel(/Phone number/);
  await expect(phone).toBeEditable();
  await phone.fill(PHONE.admin);
  await page.getByRole("button", { name: "Complete setup" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already" })).toHaveText(
    "That number is already on MatchTime, so it can't be added to your account.",
  );
  expect((await phoneOf(db, U.guest)).phoneNumber).toBeNull();
  expect((await phoneOf(db, U.admin)).phoneNumber).toBe(PHONE.admin);

  await phone.fill("07700 900777");
  await page.getByRole("button", { name: "Complete setup" }).click();
  await page.waitForURL((url) => url.pathname !== "/welcome", { timeout: 30_000 });
  const row = await phoneOf(db, U.guest);
  expect(row.phoneNumber).toBe("+447700900777");
  expect(row.onboarded).toBe(true);
});

test("profile: the stored number is read-only and survives a name change", async ({ page, db }) => {
  await signInAs(page, U.rater, "/profile");
  await page.getByRole("button", { name: "Edit" }).click();

  const phone = page.getByLabel("Phone number");
  await expect(phone).toHaveValue(PHONE.rater);
  await expect(phone).not.toBeEditable();
  await expect(page.getByTestId("phone-signin-note")).toBeVisible();

  await page.getByLabel("Name").fill("Riley Renamed");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Profile updated!" }).first()).toBeVisible({
    timeout: 15_000,
  });

  const row = await phoneOf(db, U.rater);
  expect(row.name).toBe("Riley Renamed");
  expect(row.phoneNumber).toBe(PHONE.rater);
});

test("profile: a player with no number may add one", async ({ page, db }) => {
  await signInAs(page, U.guest, "/profile");
  await page.getByRole("button", { name: "Edit" }).click();
  const phone = page.getByLabel("Phone number");
  await expect(phone).toBeEditable();
  await phone.fill("+44 7700 900778");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Profile updated!" }).first()).toBeVisible({
    timeout: 15_000,
  });
  expect((await phoneOf(db, U.guest)).phoneNumber).toBe("+447700900778");
  // Shown back, now read-only.
  await expect(page.getByText("+447700900778")).toBeVisible();
});
