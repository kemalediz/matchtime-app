/**
 * POOL SCENARIOS: a friend's share link and the owner's source codes
 * (growth slice G1, 2026-10-24). A pool player opens his manage page from
 * the real link in his welcome, takes his share link off the real "Bring a
 * friend" card, and a friend signs up through it on /play and confirms on
 * WhatsApp. We assert what MatchTime sent, to whom, and the attribution the
 * database holds. Model-free: $0.
 *
 * The rules under test (`src/lib/pool/growth-rules.ts`): first touch; the
 * referral settled once as the friend goes live; self-referrals, stopped
 * referrers and numbers already on MatchTime never kept as referrals; the
 * link and the message never carry the sharer's number; his name shows on
 * /play only while his privacy switch allows.
 */
import type { Page } from "@playwright/test";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { poolShareCopy } from "@/lib/i18n/pool-share";
import { scenario, scenarios, expect } from "./fixtures";
import type { PoolPerson, PoolWorld } from "./world";

const EN = poolPageCopy("en").manage;
const SHARE_EN = poolShareCopy("en");
const SHARE_TR = poolShareCopy("tr");

/** Sign up, confirm, open the manage link from the welcome, read the share link. */
async function joinAndReadShareLink(pool: PoolWorld, page: Page, who: PoolPerson, name: string): Promise<{ url: string; code: string }> {
  const form = await pool.signUp({ name });
  const welcome = (await who.dm(form.prefill!)).sent[0];
  const link = /https?:\/\/\S+\/r\/[A-Za-z0-9]+/.exec(welcome.text)?.[0];
  expect(link, welcome.text).toBeTruthy();
  await page.goto(link!);
  await page.waitForURL("**/play/manage", { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: EN.heading })).toBeVisible();
  const card = page.getByTestId("pool-share-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const url = await page.getByTestId("pool-share-link").inputValue();
  const code = /\/play\?ref=([A-Z0-9]{6})$/.exec(url)?.[1];
  expect(code, url).toBeTruthy();
  return { url, code: code! };
}

scenarios("a friend's share link", () => {
  scenario("happy path: Bea signs up through Ali's link and confirms; the referral is stored, Ali hears nothing, his number is nowhere", async ({ pool, page }) => {
    const ali = await pool.stranger("ali", { name: "Ali Kaya" });
    const bea = await pool.stranger("bea", { name: "Bea Lee" });
    const { url, code } = await joinAndReadShareLink(pool, page, ali, "Ali Kaya");

    pool.note("the card: his link, the ready-to-forward message, the WhatsApp button with no number in it");
    await expect(page.getByTestId("pool-share-message")).toHaveText(SHARE_EN.message(url));
    const wa = await page.getByTestId("pool-share-whatsapp").getAttribute("href");
    expect(wa).toBe(`https://wa.me/?text=${encodeURIComponent(SHARE_EN.message(url))}`);
    for (const v of ali.phoneVariants()) {
      expect(url).not.toContain(v);
      expect(decodeURIComponent(wa!)).not.toContain(v);
    }
    await expect(page.getByTestId("pool-share-privacy")).toHaveText(SHARE_EN.recognitionOn("Ali K."));
    pool.note("the same card in Turkish");
    await page.getByRole("button", { name: "Türkçe" }).click();
    await expect(page.getByTestId("pool-share-message")).toHaveText(SHARE_TR.message(url));

    pool.note("the same code every time he looks");
    await page.reload();
    await expect(page.getByTestId("pool-share-link")).toHaveValue(url);

    pool.note("Bea opens the link: /play says who invited her");
    await page.goto(url);
    await expect(page.getByTestId("pool-invited-by")).toHaveText(SHARE_EN.invitedBy("Ali K."));

    const form = await pool.signUp({ name: "Bea Lee", language: "tr", source: { ref: code } });
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ source: "referral", sourceCode: code });
    const ex = await bea.dm(form.prefill!);

    pool.expectSent(ex.sent, [{ to: "bea", channel: "dm", purpose: "pool-welcome", text: /^✅ Teşekkürler Bea/ }]);
    const aliUser = await pool.userOf(ali);
    expect(await pool.profileOf(bea)).toMatchObject({ status: "active", source: "referral", sourceCode: code, referrerUserId: aliUser!.id, referralCountedAt: null });
    pool.expectNoLeaks([...ali.phoneVariants(), "Ali Kaya"], { to: ["bea"] });
  });

  scenario("his privacy switch off: /play shows no name, and the card says so", async ({ pool, page }) => {
    const ali = await pool.stranger("ali2", { name: "Ali Kaya" });
    const { url } = await joinAndReadShareLink(pool, page, ali, "Ali Kaya");

    await page.getByRole("switch", { name: poolPageCopy("en").manage.showRecognitionLabel }).uncheck();
    await expect.poll(async () => (await pool.profileOf(ali))!.showRecognition).toBe(false);
    await expect(page.getByTestId("pool-share-privacy")).toHaveText(SHARE_EN.recognitionOff);

    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("pool-invited-by")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Ali");
  });

  scenario("a referrer who stopped: the friend still joins, his source is kept, no referrer is stored", async ({ pool, page }) => {
    const ali = await pool.stranger("ali3", { name: "Ali Kaya" });
    const cem = await pool.stranger("cem", { name: "Cem" });
    const { url, code } = await joinAndReadShareLink(pool, page, ali, "Ali Kaya");
    await page.getByRole("button", { name: EN.stop }).click();
    await expect(page.getByTestId("pool-status")).toHaveText(EN.status.stopped);
    await expect(page.getByTestId("pool-share-card")).toHaveCount(0);

    await page.goto(url);
    await expect(page.getByTestId("pool-invited-by")).toHaveCount(0);

    const form = await pool.signUp({ name: "Cem Ak", source: { ref: code } });
    const ex = await cem.dm(form.prefill!);
    pool.expectSent(ex.sent, [{ to: "cem", purpose: "pool-welcome" }]);
    expect(await pool.profileOf(cem)).toMatchObject({ status: "active", source: "referral", sourceCode: code, referrerUserId: null });
  });

  scenario("a number already on MatchTime (a club member) through a friend's link: joins, never kept as a referral", async ({ pool, page }) => {
    const fnf = await pool.club("fnf", { name: "Friday Night Football" });
    const pete = fnf.member("pete");
    const ali = await pool.stranger("ali4", { name: "Ali Kaya" });
    const { code } = await joinAndReadShareLink(pool, page, ali, "Ali Kaya");

    const form = await pool.signUp({ name: "Pete P", source: { ref: code } });
    const ex = await pete.dm(form.prefill!);
    pool.expectSent(ex.sent, [{ to: "fnf.pete", purpose: "pool-welcome" }]);
    expect(await pool.profileOf(pete)).toMatchObject({ status: "active", source: "referral", sourceCode: code, referrerUserId: null });
  });

  scenario("his own link, confirmed from his own number: nothing attached, no referral to himself", async ({ pool, page }) => {
    const ali = await pool.stranger("ali5", { name: "Ali Kaya" });
    const { code } = await joinAndReadShareLink(pool, page, ali, "Ali Kaya");
    const aliUser = await pool.userOf(ali);

    const form = await pool.signUp({ name: "Ali Again", source: { ref: code } });
    const ex = await ali.dm(form.prefill!);
    expect(ex.json).toMatchObject({ handled: "pool-confirm", result: "already-signed-up" });
    expect(await pool.profileOf(ali)).toMatchObject({ displayName: "Ali Kaya", referrerUserId: null });
    pool.note("the waiting sign-up never goes live on his number (the housekeeping removes it after 7 days)");
    expect(await pool.pendingByCode(form.code!)).toMatchObject({ status: "pending-verify", userId: null });
    expect(await pool.db.count(`SELECT count(*) FROM "PoolProfile" WHERE "referrerUserId" = $1 AND status <> 'pending-verify'`, [aliUser!.id])).toBe(0);
  });

  scenario("a made-up share code is just the web; a live campaign's ?src= is stamped as the campaign", async ({ pool }) => {
    await pool.db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ('leaflet-sutton-oct', 'leaflet', 'Sutton leaflets') ON CONFLICT DO NOTHING`);
    const dan = await pool.stranger("dan", { name: "Dan" });
    const fake = await pool.signUp({ name: "Fake Ref", source: { ref: "ZZZZZZ" } });
    expect(await pool.pendingByCode(fake.code!)).toMatchObject({ source: "web", sourceCode: null, referrerUserId: null });

    const form = await pool.signUp({ name: "Dan D", source: { src: "leaflet-sutton-oct" } });
    await dan.dm(form.prefill!);
    expect(await pool.profileOf(dan)).toMatchObject({ status: "active", source: "campaign", sourceCode: "leaflet-sutton-oct", referrerUserId: null });
  });
});
