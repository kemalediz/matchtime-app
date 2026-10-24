/**
 * POOL SCENARIOS: managing the profile from the link in the welcome, then
 * messaging MatchTime again (slice L2, 2026-10-24). The person taps the
 * link MatchTime sent him (a real signed short link), uses the real manage
 * page in a browser, and writes again on WhatsApp. Model-free: $0.
 */
import type { Page } from "@playwright/test";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { scenario, scenarios, expect } from "./fixtures";
import type { PoolPerson, PoolWorld } from "./world";

const EN = poolPageCopy("en").manage;

/** Sign up, confirm, and open the manage link from the welcome. */
async function joinAndOpenManage(pool: PoolWorld, page: Page, who: PoolPerson, name: string) {
  const form = await pool.signUp({ name });
  const welcome = (await who.dm(form.prefill!)).sent[0];
  const link = /https?:\/\/\S+\/r\/[A-Za-z0-9]+/.exec(welcome.text)?.[0];
  expect(link, welcome.text).toBeTruthy();
  await page.goto(link!);
  await page.waitForURL("**/play/manage", { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: EN.heading })).toBeVisible();
  return form;
}

scenarios("managing the profile, then messaging again", () => {
  scenario("stop offers, then the old message again, then a new sign-up: one profile, a fresh consent, one new welcome", async ({ pool, page }) => {
    const ali = await pool.stranger("ali");
    const old = await joinAndOpenManage(pool, page, ali, "Ali Kaya");

    await page.getByRole("button", { name: EN.stop }).click();
    await expect(page.getByTestId("pool-status")).toHaveText(EN.status.stopped);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "stopped" });

    pool.note("he sends his old message again: the code is spent");
    const again = await ali.dm(old.prefill!);
    pool.expectSent(again.sent, [{ to: "ali", purpose: "pool-code-reply", text: /couldn't find a sign-up/ }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "stopped" });

    pool.note("he signs up again on /play and confirms");
    const fresh = await pool.signUp({ name: "Ali K" });
    const back = await ali.dm(fresh.prefill!);
    pool.expectSent(back.sent, [{ to: "ali", purpose: "pool-welcome", text: /Thanks Ali/ }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "active", displayName: "Ali K", consentEvidence: back.messageId });
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" p JOIN "User" u ON u.id = p."userId" WHERE u."phoneNumber" = $1`, [ali.phone])).toBe(1);
  });

  scenario("delete (a pool-only person): profile and User erased; he is a stranger again", async ({ pool, page }) => {
    const bob = await pool.stranger("bob", { name: "Bob" });
    const old = await joinAndOpenManage(pool, page, bob, "Bob Brown");

    await page.getByRole("button", { name: EN.deleteButton }).click();
    await page.getByRole("button", { name: EN.deleteConfirm }).click();
    await expect(page.getByRole("heading", { level: 1, name: EN.deletedHeading })).toBeVisible();
    expect(await pool.userOf(bob)).toBeNull();

    const hi = await bob.dm("hi, is there a game this week?");
    expect(hi.json).toMatchObject({ ignored: "unknown-sender" });
    pool.expectSent(hi.sent, []);

    const replay = await bob.dm(old.prefill!);
    pool.expectSent(replay.sent, [{ to: "bob", purpose: "pool-code-reply" }]);
    expect(await pool.userOf(bob)).toBeNull();
  });

  scenario("delete (a club member): the pool profile goes, his User and club stay", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "Friday Night Football" });
    const pete = fnf.member("pete");
    const user = await pool.userOf(pete);
    await joinAndOpenManage(pool, page, pete, "Pete P");

    await page.getByRole("button", { name: EN.deleteButton }).click();
    await page.getByRole("button", { name: EN.deleteConfirm }).click();
    await expect(page.getByRole("heading", { level: 1, name: EN.deletedHeading })).toBeVisible();

    expect(await pool.profileOf(pete)).toBeNull();
    expect(await pool.userOf(pete)).toMatchObject({ id: user!.id });
    expect(await pool.db.count(`SELECT count(*) FROM "Membership" WHERE "userId" = $1 AND "leftAt" IS NULL`, [user!.id])).toBeGreaterThan(0);
  });

  scenario("pause from the link: the profile pauses itself, and a later message gets no pool reply", async ({ pool, page }) => {
    const can = await pool.stranger("can");
    await joinAndOpenManage(pool, page, can, "Can Demir");

    await page.getByRole("button", { name: EN.pause }).click();
    await expect(page.getByTestId("pool-status")).toHaveText(EN.status.paused);
    expect(await pool.profileOf(can)).toMatchObject({ status: "paused", pausedReason: "self" });

    const ex = await can.dm("thanks!");
    expect(ex.json.handled).not.toBe("pool-confirm");
    pool.expectSent(ex.sent, []);
  });
});
