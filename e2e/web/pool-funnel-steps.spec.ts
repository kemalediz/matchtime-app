/**
 * The /play sign-up funnel (2026-11-04), end to end on the real dev server:
 *   - opening /play counts "opened" once per tab session (as since
 *     2026-11-03), and the first time a person enters something in the
 *     form (types a character, ticks a box) counts "started" once per tab
 *     session, under the same code; focus, clicks and a script's synthetic
 *     events count nothing (2026-11-06, after a scanner);
 *   - a fetcher calling the beacon counts nothing, and a page claiming the
 *     server's steps (sent, confirmed) counts nothing;
 *   - the owner's source codes page shows opened, started, sent and
 *     confirmed for today, 7 days or 30 days, with the drop between steps.
 * The server's own steps (sent, confirmed) are e2e/sim/pool/funnel-steps.spec.ts.
 * No model anywhere: $0.
 */
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { poolFunnelPeriodStart, poolVisitDay } from "@/lib/pool/visit-rules";

const FACEBOOK = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CODE = "e2e-funnel-web";

test.describe.configure({ mode: "serial" });
test.beforeAll(() => resetDb());
test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

const count = async (db: TestDb, code: string, step: string) =>
  Number((await db.one<{ n: string | null }>(`SELECT sum(count)::text AS n FROM "PoolCampaignVisit" WHERE code = $1 AND step = $2`, [code, step]))?.n ?? 0);

/** Give an after-answer write its chance, then check it never came. */
const settle = () => new Promise((r) => setTimeout(r, 1500));

test.describe("the page's steps", () => {
  test.use({ userAgent: PERSON, locale: "en-GB" });

  test.beforeAll(async ({ db }) => {
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel web e2e') ON CONFLICT DO NOTHING`, [CODE]);
  });

  test("opened on load; started only once a person types, once; nothing for focus, clicks or a script's events", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    await page.goto(`/play?src=${CODE}`);
    await expect.poll(() => count(db, CODE, "opened"), { timeout: 15_000 }).toBe(1);

    const form = page.locator("form");
    const name = form.locator("input[name=name]");
    // What the 6 November 2026 scanner did: a click outside the form, focus and clicks on its fields and its submit.
    await page.getByRole("heading", { level: 1 }).click();
    await name.focus();
    await name.click();
    await form.locator("input[name=district]").click();
    // A script's own events (untrusted), even ones that change a value: a typed-in name and a ticked day.
    await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>("form input[name=district]")!;
      field.value = "SM1";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector<HTMLInputElement>("form input[type=checkbox]")!.click();
    });
    await settle();
    expect(await count(db, CODE, "started")).toBe(0);

    // A person types one character: started.
    await name.pressSequentially("S");
    await expect.poll(() => count(db, CODE, "started"), { timeout: 15_000 }).toBe(1);

    // More typing, a tick, a reload and more typing: the same tab session, so still one.
    await name.pressSequentially("omeone");
    await form.locator("input[type=checkbox]").first().click();
    await page.reload();
    await page.locator("form input[name=district]").pressSequentially("SM");
    await page.waitForLoadState("networkidle");
    await settle();
    expect(await count(db, CODE, "started")).toBe(1);
    expect(await count(db, CODE, "opened")).toBe(1);
  });

  test("a new tab session counts both steps again; ticking a box is entering something", async ({ browser, db }) => {
    const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    const page = await context.newPage();
    await page.goto(`/play?src=${CODE}`);
    await expect.poll(() => count(db, CODE, "opened"), { timeout: 15_000 }).toBe(2);
    await page.locator("form input[type=checkbox]").first().click();
    await expect.poll(() => count(db, CODE, "started"), { timeout: 15_000 }).toBe(2);
    expect(await count(db, CODE, "opened")).toBe(2);
    await context.close();
  });

  test("a fetcher's beacon counts nothing, and a page cannot claim the server's steps", async ({ request, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit"`);
    const fetcher = await request.post("/api/play/visit", { headers: { "user-agent": FACEBOOK }, data: JSON.stringify({ src: CODE, step: "started" }) });
    expect(fetcher.status()).toBe(204);
    for (const step of ["sent", "confirmed"]) {
      const res = await request.post("/api/play/visit", { headers: { "user-agent": PERSON }, data: JSON.stringify({ src: CODE, step }) });
      expect(res.status()).toBe(204);
    }
    await settle();
    expect(await db.one(`SELECT count(*)::int AS n FROM "PoolCampaignVisit"`)).toEqual({ n: 0 });
  });
});

test.describe("the owner's funnel", () => {
  test("opened, started, sent, confirmed per code and without a code, for today, 7 days or 30 days, with the drop", async ({ page, db }) => {
    await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel web e2e') ON CONFLICT DO NOTHING`, [CODE]);
    await db.run(`DELETE FROM "PoolCampaignVisit"`);
    const today = poolVisitDay(new Date());
    const tenDaysAgo = poolFunnelPeriodStart("today", new Date(Date.now() - 10 * 86_400_000));
    const put = (code: string, day: string, step: string, n: number) =>
      db.run(`INSERT INTO "PoolCampaignVisit" (code, day, step, count) VALUES ($1, $2::date, $3, $4)`, [code, day, step, n]);
    await put(CODE, today, "opened", 24);
    await put(CODE, today, "started", 5);
    await put(CODE, today, "sent", 1);
    await put(CODE, today, "confirmed", 1);
    await put(CODE, tenDaysAgo, "opened", 100);
    await put("_direct", today, "opened", 3);

    await signInAs(page, U.admin, "/admin/pool/campaigns");
    const row = page.locator(`[data-testid="campaign-row"][data-code="${CODE}"]`);
    const period = page.getByRole("navigation", { name: "Period" });
    // Default: 7 days.
    await expect(period.getByRole("link", { name: "7 days" })).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(row.getByTestId("campaign-opened")).toHaveText("24");
    await expect(row.getByTestId("campaign-started")).toHaveText("5");
    await expect(row.getByTestId("campaign-lost-started")).toHaveText("19 did not start (79%)");
    await expect(row.getByTestId("campaign-sent")).toHaveText("1");
    await expect(row.getByTestId("campaign-lost-sent")).toHaveText("4 did not send it (80%)");
    await expect(row.getByTestId("campaign-confirmed")).toHaveText("1");
    await expect(row.getByTestId("campaign-lost-confirmed")).toHaveText("nobody stopped");
    await expect(row.getByTestId("campaign-lost-opened")).toHaveCount(0);
    const direct = page.getByTestId("way-in-direct");
    await expect(direct.getByTestId("direct-opened")).toHaveText("3");
    await expect(direct.getByTestId("direct-lost-started")).toHaveText("3 did not start (100%)");
    // Nothing to compare after a step nobody reached.
    await expect(direct.getByTestId("direct-lost-sent")).toHaveCount(0);

    await period.getByRole("link", { name: "30 days" }).click();
    await expect(period.getByRole("link", { name: "30 days" })).toHaveAttribute("aria-current", "page");
    await expect(row.getByTestId("campaign-opened")).toHaveText("124");
    await expect(row.getByTestId("campaign-lost-started")).toHaveText("119 did not start (96%)");

    await period.getByRole("link", { name: "Today" }).click();
    await expect(period.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
    await expect(row.getByTestId("campaign-opened")).toHaveText("24");

    // Readable on a phone: the four steps fit the screen's width, nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await row.getByTestId("campaign-confirmed").scrollIntoViewIfNeeded();
    await expect(row.getByTestId("campaign-confirmed")).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
