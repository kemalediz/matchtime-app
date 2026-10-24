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
  scenario("stop offers, his own message again, a NEW sign-up's code: never attached; he starts again from his link", async ({ pool, page }) => {
    const ali = await pool.stranger("ali");
    const old = await joinAndOpenManage(pool, page, ali, "Ali Kaya");

    await page.getByRole("button", { name: EN.stop }).click();
    await expect(page.getByTestId("pool-status")).toHaveText(EN.status.stopped);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "stopped" });

    pool.note("he sends his own old message again: his own spent code, silent");
    const again = await ali.dm(old.prefill!);
    expect(again.json).toMatchObject({ handled: "pool-confirm", result: "already-in-pool" });
    pool.expectSent(again.sent, []);

    pool.note("a new sign-up's code from his number: it is not attached to him");
    const fresh = await pool.signUp({ name: "Ali K" });
    const back = await ali.dm(fresh.prefill!);
    expect(back.json).toMatchObject({ handled: "pool-confirm", result: "already-signed-up" });
    pool.expectSent(back.sent, [{ to: "ali", purpose: "pool-code-reply", text: /^You already have a MatchTime player pool profile, and you stopped game messages/ }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "stopped", displayName: "Ali Kaya" });
    expect(await pool.pendingByCode(fresh.code!)).toMatchObject({ status: "pending-verify", userId: null });
    expect(await pool.failedAttempts(ali)).toBe(1);

    pool.note("he starts again on the page, with the consent ticked");
    await page.reload();
    await page.getByRole("checkbox", { name: EN.restartConsent }).check();
    await page.getByRole("button", { name: EN.restart }).click();
    await expect(page.getByTestId("pool-status")).toHaveText(EN.status.active);
    const user = await pool.userOf(ali);
    expect(await pool.consentRecords(user!.id)).toEqual([
      { action: "consent", channel: "whatsapp" },
      { action: "withdraw", channel: "web" },
      { action: "consent", channel: "web" },
    ]);
  });

  scenario("delete (a pool-only person): profile and User erased; he is a stranger again", async ({ pool, page }) => {
    const bob = await pool.stranger("bob", { name: "Bob" });
    const old = await joinAndOpenManage(pool, page, bob, "Bob Brown");

    await page.getByRole("button", { name: EN.deleteButton }).click();
    await page.getByRole("button", { name: EN.deleteConfirm }).click();
    await expect(page.getByRole("heading", { level: 1, name: EN.deletedHeading })).toBeVisible();
    const userId = (await pool.db.one<{ userId: string }>(`SELECT "userId" FROM "PoolConsentRecord" WHERE phone = $1`, [bob.phone.slice(1)]))!.userId;
    expect(await pool.userOf(bob)).toBeNull();
    pool.note("the consent record outlives the profile and the User (the privacy policy's 6 years)");
    expect(await pool.consentRecords(userId)).toEqual([
      { action: "consent", channel: "whatsapp" },
      { action: "withdraw", channel: "web" },
    ]);

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
