/**
 * Sign-up codes go out even when NO club has its bot switched on
 * (self-join slice 3).
 *
 * The old sign-up borrowed "the first bot-enabled org" as a sender and,
 * finding none, told the visitor "MatchTime is still warming up". Kemal
 * muted Sutton FC twice in one week; had it been the only live club, no one
 * could have signed up. Now the code is a PlatformJob that the Pi polls
 * for directly. This drives the real /signup page with every club's bot
 * off and follows the code all the way to the Pi's poll.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const PHONE_DIGITS = "447700900961";

test.beforeAll(async () => {
  resetDb();
  await testDb().run(`UPDATE "Organisation" SET "whatsappBotEnabled" = false`);
});

test.afterAll(async () => {
  // Leave the world as the next spec expects it.
  resetDb();
});

test("a visitor gets a sign-up code with every club's bot switched off", async ({ page, request }) => {
  expect(await testDb().count(`SELECT COUNT(*) FROM "Organisation" WHERE "whatsappBotEnabled"`)).toBe(0);

  await page.goto("/signup");
  await page.getByPlaceholder("Kemal Ediz").fill("Ali Demir");
  await page.getByPlaceholder("+44 7xxx xxxxxx").fill(`+${PHONE_DIGITS}`);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check WhatsApp" })).toBeVisible();

  const otp = await testDb().one<{ code: string }>(
    `SELECT code FROM "PhoneOtp" WHERE phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [PHONE_DIGITS],
  );
  expect(otp?.code).toMatch(/^\d{6}$/);

  const job = await testDb().one<{ id: string; status: string; purpose: string; text: string }>(
    `SELECT id, status, purpose, text FROM "PlatformJob" WHERE phone = $1`,
    [PHONE_DIGITS],
  );
  expect(job).toMatchObject({ status: "queued", purpose: "otp" });
  expect(job?.text).toContain(otp!.code);
  // Nothing was borrowed from a club.
  expect(await testDb().count(`SELECT COUNT(*) FROM "BotJob" WHERE phone = $1`, [PHONE_DIGITS])).toBe(0);

  // The Pi's poll hands it over, with the code in it.
  const res = await request.get("/api/whatsapp/platform-jobs", { headers: { "x-api-key": E2E.WHATSAPP_API_KEY } });
  expect(res.status()).toBe(200);
  const { jobs } = (await res.json()) as { jobs: Array<{ id: string; kind: string; phone: string; text: string }> };
  expect(jobs).toEqual([expect.objectContaining({ id: job!.id, kind: "dm", phone: PHONE_DIGITS })]);
  expect(jobs[0].text).toContain(otp!.code);
});
