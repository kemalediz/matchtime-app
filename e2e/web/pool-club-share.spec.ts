/**
 * "Tell your players about the player pool" on /admin/settings (growth
 * slice G3): shown only while the club has the player pool; the exact post
 * with the club's campaign link; Send queues ONE players' group post and
 * the card then says where it is: "Queued: goes out ..." until the post
 * has gone out (held by quiet hours: the time it goes), then "Sent to your
 * players' group on <date>."; a double tap, a reload and a second tap send
 * nothing more; no players' group: no Send; English and Turkish; phone and
 * desktop width. What reaches the group, and when, is
 * e2e/sim/pool/club-share.spec.ts.
 */
import { test, expect, signInAs, U } from "../fixtures";
import { setPoolPlatform } from "../helpers/pool-platform";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";

// The pool cards and Invite to club show only while the platform switch is on.
test.beforeEach(async ({ db }) => setPoolPlatform(db, true));

test.describe.configure({ mode: "serial" });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const KEY = `org-${ORG_ID}:pool-club-share`;

type Db = import("../helpers/test-db").TestDb;

const postsQueued = async (db: Db) =>
  (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' AND text LIKE '%play?src=club-%'`, [ORG_ID])).map((r) => r.text);
const claims = async (db: Db) => Number((await db.one<{ n: string }>(`SELECT count(*) AS n FROM "SentNotification" WHERE key = $1`, [KEY]))?.n ?? 0);

async function reset(db: Db) {
  await db.run(`DELETE FROM "SentNotification" WHERE key = $1`, [KEY]);
  await db.run(`DELETE FROM "BotJob" WHERE "orgId" = $1 AND text LIKE '%play?src=club-%'`, [ORG_ID]);
  await db.run(`DELETE FROM "PoolCampaign" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false, language = 'en', "whatsappGroupId" = $2, "whatsappBotEnabled" = true, "quietHoursEnabled" = false WHERE id = $1`, [ORG_ID, E2E.GROUP_ID]);
}

async function openSettings(page: import("@playwright/test").Page) {
  // The card's own link: its tab open and the card expanded.
  await signInAs(page, U.admin, "/admin/settings#pool-club-share");
  await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

/** The post as the Pi would mark it, once it has gone out. */
const markPostSent = (db: Db, at: string) =>
  db.run(`UPDATE "BotJob" SET "sentAt" = $2 WHERE "orgId" = $1 AND text LIKE '%play?src=club-%'`, [ORG_ID, at]);

test.beforeEach(async ({ db }) => reset(db));
test.afterEach(async ({ db }) => {
  await reset(db);
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = true WHERE id = $1`, [ORG_ID]);
});

test("hidden while the club does not have the player pool, and nothing is made", async ({ page, db }) => {
  await openSettings(page);
  await expect(page.getByTestId("pool-club-share")).toHaveCount(0);
  expect(await db.one(`SELECT code FROM "PoolCampaign" WHERE "orgId" = $1`, [ORG_ID])).toBeFalsy();
});

for (const [label, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`the exact post with the club's link; Send once, queued, then the date it went out (${label})`, async ({ page, db }) => {
    await page.setViewportSize(viewport);
    await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);
    await openSettings(page);

    const card = page.getByTestId("pool-club-share");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("heading", { name: "Tell your players about the player pool" })).toBeVisible();
    const text = page.getByTestId("pool-club-share-text");
    await expect(text).toContainText("The MatchTime player pool");
    await expect(text).toContainText("Play elsewhere too");
    await expect(text).toContainText(/\/play\?src=club-e2e-test-fc/);
    // The code is the club's, made by the G1 campaign module.
    expect(await db.one(`SELECT code, source, label FROM "PoolCampaign" WHERE "orgId" = $1`, [ORG_ID])).toEqual({
      code: "club-e2e-test-fc",
      source: "club",
      label: expect.stringMatching(/ share post$/),
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const shown = await text.textContent();
    // A double tap: one send.
    await page.getByTestId("pool-club-share-send").dblclick();
    await expect(page.getByText("Sent. It will be in your players' group in a minute or two.")).toBeVisible();
    // Not out yet: queued, never "sent" while the post waits.
    await expect(page.getByTestId("pool-club-share-queued")).toHaveText("Queued: goes out in a minute or two.");
    await expect(page.getByTestId("pool-club-share-sent")).toHaveCount(0);
    await expect(page.getByTestId("pool-club-share-send")).toHaveCount(0);
    await expect.poll(() => postsQueued(db), { timeout: 15_000 }).toHaveLength(1);
    expect((await postsQueued(db))[0]).toBe(shown);
    expect(await claims(db)).toBe(1);

    // The post goes out: after a reload the card says when, in London time.
    await markPostSent(db, "2026-10-28T09:00:30Z");
    await page.reload();
    await expect(page.getByTestId("pool-club-share-sent")).toHaveText("Sent to your players' group on 28 Oct 2026.", { timeout: 30_000 });
    await expect(page.getByTestId("pool-club-share-queued")).toHaveCount(0);
    await expect(page.getByTestId("pool-club-share-send")).toHaveCount(0);
    // Collapsed, its summary says the same.
    await page.getByTestId("settings-card-toggle-pool-club-share").click();
    await expect(page.getByTestId("settings-card-summary-pool-club-share")).toHaveText("Sent to your players' group on 28 Oct 2026.");
    expect(await postsQueued(db)).toHaveLength(1);
  });
}

test("tapped inside quiet hours: queued until they end, with the time it goes out", async ({ page, db }) => {
  // Quiet hours around now (London), ending in two hours: the post is held.
  const london = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const from = london(new Date(Date.now() - 60 * 60_000));
  const to = london(new Date(Date.now() + 2 * 60 * 60_000));
  await db.run(
    `UPDATE "Organisation" SET "featurePlayerPool" = true, "quietHoursEnabled" = true, "quietHoursFrom" = $2, "quietHoursTo" = $3 WHERE id = $1`,
    [ORG_ID, from, to],
  );
  try {
    await openSettings(page);
    await page.getByTestId("pool-club-share-send").click({ timeout: 30_000 });
    const queued = page.getByTestId("pool-club-share-queued");
    // Today, or the date as well when the hold runs past midnight.
    await expect(queued).toHaveText(new RegExp(`^Queued: goes out (at|on \\d{1,2} \\w{3} \\d{4} at) ${to}\\.$`));
    const held = await db.one<{ sendAfter: Date | null; sentAt: Date | null }>(
      `SELECT "sendAfter", "sentAt" FROM "BotJob" WHERE "orgId" = $1 AND text LIKE '%play?src=club-%'`,
      [ORG_ID],
    );
    expect(held?.sentAt).toBeNull();
    expect(london(held!.sendAfter!)).toBe(to);
    await page.reload();
    await expect(page.getByTestId("pool-club-share-queued")).toHaveText(await queued.textContent() ?? "", { timeout: 30_000 });

    // A Turkish club reads it in Turkish.
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    await page.reload();
    await expect(page.getByTestId("pool-club-share-queued")).toHaveText(/^Sırada: (\d{1,2} \S+ \d{4}, )?\d{2}:\d{2}'(da|de|ta|te) gönderilecek\.$/, { timeout: 30_000 });
  } finally {
    await db.run(`UPDATE "Organisation" SET "quietHoursFrom" = '23:00', "quietHoursTo" = '09:00' WHERE id = $1`, [ORG_ID]);
  }
});

test("no players' group: the post is shown, Send is not", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true, "whatsappBotEnabled" = false WHERE id = $1`, [ORG_ID]);
  await openSettings(page);
  await expect(page.getByTestId("pool-club-share-text")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pool-club-share-no-group")).toBeVisible();
  await expect(page.getByTestId("pool-club-share-send")).toHaveCount(0);
  expect(await claims(db)).toBe(0);
});

test("a Turkish club reads the card and the post in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true, language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings#pool-club-share");
  const card = page.getByTestId("pool-club-share");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("heading", { name: "Oyuncularınıza oyuncu havuzunu anlatın" })).toBeVisible();
  await expect(page.getByTestId("pool-club-share-text")).toContainText("Başka yerlerde de oyna");
  await page.getByRole("button", { name: "Oyuncu grubuna gönder" }).click();
  await expect(page.getByText("Gönderildi. Bir iki dakika içinde oyuncu grubunuzda olacak.")).toBeVisible();
  await expect(page.getByTestId("pool-club-share-queued")).toHaveText("Sırada: bir iki dakika içinde gönderilecek.");
  await expect.poll(() => postsQueued(db), { timeout: 15_000 }).toHaveLength(1);
  expect((await postsQueued(db))[0]).toContain("MatchTime oyuncu havuzu");
  await markPostSent(db, "2026-10-28T09:00:30Z");
  await page.reload();
  await expect(page.getByTestId("pool-club-share-sent")).toHaveText("Oyuncu grubunuza 28 Eki 2026'da gönderildi.", { timeout: 30_000 });
});
