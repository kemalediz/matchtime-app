/**
 * The /play sign-up funnel (2026-11-04), end to end on the real dev server:
 *   - opening /play counts "opened" once per tab session (as since
 *     2026-11-03), but only once a person shows he is there: a tap, a key,
 *     a wheel or a scroll (2026-11-12), or typing first. Time on screen
 *     counts nothing since 2026-11-16: on 15 November all 4 counted opens
 *     were scanners that waited exactly 5000 ms;
 *   - our own staff count nothing (2026-11-12), and staff means MatchTime
 *     staff (2026-11-16): a browser that loaded an /admin page as a
 *     superadmin carries the staff cookie; a club's owner or admin gets
 *     none, and the old cookie every organiser got until then counts;
 *   - the first time a person enters something in the
 *     form (types a character, ticks a box) counts "started" once per tab
 *     session, under the same code; focus, clicks and a script's synthetic
 *     events count nothing (2026-11-06, after a scanner);
 *   - a fetcher calling the beacon counts nothing, and a page claiming the
 *     server's steps (sent, confirmed) counts nothing;
 *   - the opened beacon says what opened the page, and the breakdown
 *     (2026-11-16) keeps DAILY TOTALS of OPENS only, per code, day,
 *     trigger, in-app browser and scanner flag: no browser, no device, no
 *     starts, no time of day, no time on screen, no address or user agent;
 *     a fetcher is added as a scanner, our staff not at all;
 *   - the staff cookie is set by the server (2026-11-16), HttpOnly, so
 *     WebKit's 7-day cap on script-set cookies does not apply;
 *   - the owner's source codes page shows opened, started, sent and
 *     confirmed for today, 7 days or 30 days, with the drop between steps.
 * The server's own steps (sent, confirmed, a staff test sign-up) are
 * e2e/sim/pool/funnel-steps.spec.ts. No model anywhere: $0.
 */
import type { Page } from "@playwright/test";
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

/** Wait until React has hydrated the sign-up, so the beacon is listening. */
const hydrated = (page: Page) =>
  page.waitForFunction(() => {
    const form = document.querySelector("form");
    return !!form && Object.keys(form).some((k) => k.startsWith("__reactProps"));
  });

/** The steps the page's beacon sends, in the order it sends them. Read in
 *  the page: Playwright's request events do not report `sendBeacon`. */
async function watchBeacons(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const sent: Promise<string>[] = [];
    (window as unknown as { __mtBeacons: Promise<string>[] }).__mtBeacons = sent;
    const original = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      if (String(url).endsWith("/api/play/visit") && data instanceof Blob) sent.push(data.text());
      return original(url, data);
    };
  });
  return async () => (await beaconBodies(page)).map((b) => b.step as string);
}

/** Every beacon body the page sent, parsed (after `watchBeacons`). */
const beaconBodies = (page: Page) =>
  page.evaluate(async () => {
    const sent = (window as unknown as { __mtBeacons?: Promise<string>[] }).__mtBeacons ?? [];
    return (await Promise.all(sent)).map((body) => JSON.parse(body) as Record<string, unknown>);
  });

type DailyTotal = { code: string; day: string; step: string; trigger: string; inApp: string; scanner: boolean; count: number };
const dailyTotals = (db: TestDb, code: string) =>
  db.all<DailyTotal>(
    `SELECT "code", to_char("day", 'YYYY-MM-DD') AS day, "step", "trigger", "inApp", "scanner", "count" FROM "PoolVisitDaily" WHERE code = $1 ORDER BY "step", "trigger", "scanner"`,
    [code],
  );

test.describe("the page's steps", () => {
  test.use({ userAgent: PERSON, locale: "en-GB" });

  test.beforeAll(async ({ db }) => {
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel web e2e') ON CONFLICT DO NOTHING`, [CODE]);
  });

  test("opened once a person is there; started only once a person types, once; nothing for focus, clicks or a script's events", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    // A person scrolls: opened.
    await page.mouse.wheel(0, 300);
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
    await hydrated(page);
    await page.locator("form input[type=checkbox]").first().click();
    await expect.poll(() => count(db, CODE, "started"), { timeout: 15_000 }).toBe(2);
    await expect.poll(() => count(db, CODE, "opened"), { timeout: 15_000 }).toBe(2);
    await context.close();
  });

  // 15 November 2026: all 4 counted opens were scanners that waited exactly
  // 5000 ms. A page nobody touches is no longer an open, however long.
  test("a page left on screen well past 5 seconds, untouched, sends nothing and counts no open", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.waitForTimeout(7_000);
    expect(await beacons()).toEqual([]);
    await settle();
    expect(await count(db, CODE, "opened")).toBe(0);
  });

  test("a scroll, or a tap, counts one open at once", async ({ browser, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    for (const [n, act] of [
      [1, (page: Page) => page.mouse.wheel(0, 300)],
      [2, (page: Page) => page.getByRole("heading", { level: 1 }).click()],
    ] as const) {
      const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
      const page = await context.newPage();
      await page.goto(`/play?src=${CODE}`);
      await hydrated(page);
      await act(page);
      await expect.poll(() => count(db, CODE, "opened"), { timeout: 3_000 }).toBe(n);
      await page.mouse.wheel(0, 300);
      await settle();
      expect(await count(db, CODE, "opened")).toBe(n);
      await context.close();
    }
  });

  test("typing before any other sign sends opened first, then started", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    // Text put in without a key or a tap (as a phone's autofill or dictation does): no other sign came first.
    await page.locator("form input[name=name]").focus();
    await page.keyboard.insertText("S");
    await expect.poll(() => beacons(), { timeout: 3_000 }).toEqual(["opened", "started"]);
    expect((await beaconBodies(page))[0]).toMatchObject({ step: "opened", trigger: "before-start" });
    await expect.poll(() => count(db, CODE, "started"), { timeout: 15_000 }).toBe(1);
    expect(await count(db, CODE, "opened")).toBe(1);
  });

  test("a browser with the staff cookie counts nothing, though the page still sends", async ({ browser, baseURL, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    await context.addCookies([{ name: "mt-staff", value: "2", url: baseURL! }]);
    const page = await context.newPage();
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await page.locator("form input[name=name]").pressSequentially("Staff");
    await expect.poll(() => beacons(), { timeout: 5_000 }).toEqual(["opened", "started"]);
    await page.waitForLoadState("networkidle");
    await settle();
    expect(await count(db, CODE, "opened")).toBe(0);
    expect(await count(db, CODE, "started")).toBe(0);
    await context.close();
  });

  test("the old cookie every club organiser got until 2026-11-16 counts like none", async ({ browser, baseURL, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    await context.addCookies([{ name: "mt-staff", value: "1", url: baseURL! }]);
    const page = await context.newPage();
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => count(db, CODE, "opened"), { timeout: 15_000 }).toBe(1);
    await context.close();
  });

  test("a club owner who loads /admin gets no staff cookie, the server clears his old one, and his /play visit counts", async ({ browser, baseURL, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
    const owner = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    await owner.addCookies([{ name: "mt-staff", value: "1", url: baseURL! }]);
    const page = await owner.newPage();
    await signInAs(page, U.admin, "/admin");
    await expect.poll(async () => (await owner.cookies()).find((c) => c.name === "mt-staff")?.value, { timeout: 30_000 }).toBeUndefined();
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => count(db, CODE, "opened"), { timeout: 15_000 }).toBe(1);
    await owner.close();
  });

  test("MatchTime staff who load /admin get the staff cookie from the server, a year long and HttpOnly, and their /play visit counts nothing; a player gets none", async ({ browser, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
    const staff = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    const page = await staff.newPage();
    await signInAs(page, U.admin, "/admin");
    await expect.poll(async () => (await staff.cookies()).find((c) => c.name === "mt-staff")?.value, { timeout: 30_000 }).toBe("2");
    const cookie = (await staff.cookies()).find((c) => c.name === "mt-staff")!;
    expect(cookie.path).toBe("/");
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.expires * 1000 - Date.now()).toBeGreaterThan(360 * 86_400_000);
    // Set in a response header, never by page script (WebKit caps those at 7 days).
    expect(cookie.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain("mt-staff");
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await page.waitForLoadState("networkidle");
    await settle();
    expect(await count(db, CODE, "opened")).toBe(0);
    await staff.close();
    await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);

    const player = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    const playerPage = await player.newPage();
    await signInAs(playerPage, U.player, "/admin");
    await playerPage.waitForLoadState("networkidle");
    expect((await player.cookies()).find((c) => c.name === "mt-staff")).toBeUndefined();
    await player.close();
  });

  test("a fetcher's beacon counts nothing, and a page cannot claim the server's steps", async ({ request, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit"`);
    await db.run(`DELETE FROM "PoolVisitDaily"`);
    for (const step of ["opened", "started"]) {
      const fetcher = await request.post("/api/play/visit", { headers: { "user-agent": FACEBOOK }, data: JSON.stringify({ src: CODE, step, trigger: "touch" }) });
      expect(fetcher.status()).toBe(204);
    }
    for (const step of ["sent", "confirmed"]) {
      const res = await request.post("/api/play/visit", { headers: { "user-agent": PERSON }, data: JSON.stringify({ src: CODE, step, trigger: "touch" }) });
      expect(res.status()).toBe(204);
    }
    await settle();
    expect(await db.one(`SELECT count(*)::int AS n FROM "PoolCampaignVisit"`)).toEqual({ n: 0 });
    // The fetcher's open is in the breakdown as a scanner, and only it (a start is in no breakdown).
    expect(await dailyTotals(db, CODE)).toEqual([expect.objectContaining({ step: "opened", trigger: "touch", scanner: true, inApp: "none", count: 1 })]);
    expect(await db.one(`SELECT count(*)::int AS n FROM "PoolVisitDaily"`)).toEqual({ n: 1 });
  });
});

test.describe("the breakdown: daily totals of opens only (2026-11-16)", () => {
  test.use({ userAgent: PERSON, locale: "en-GB" });

  test.beforeAll(async ({ db }) => {
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel web e2e') ON CONFLICT DO NOTHING`, [CODE]);
  });

  test("the table holds a count per code, day, trigger, in-app browser and scanner flag: no browser, device, time of day, time on screen, address, user agent, friend's code, user id or cookie", async ({ db }) => {
    const cols = await db.all<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'PoolVisitDaily' ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["code", "count", "day", "inApp", "scanner", "step", "trigger"]);
    expect(cols.find((c) => c.column_name === "day")?.data_type).toBe("date");
    expect(await db.one(`SELECT to_regclass('"PoolVisitEvent"')::text AS t`)).toEqual({ t: null });
  });

  test("two people scroll then type: the beacons carry what opened the page and nothing else, the opens are counted together, the starts in no breakdown", async ({ browser, db }) => {
    await db.run(`DELETE FROM "PoolVisitDaily" WHERE code = $1`, [CODE]);
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
      const page = await context.newPage();
      const beacons = await watchBeacons(page);
      await page.goto(`/play?src=${CODE}&ref=AB12cd`);
      await hydrated(page);
      await page.mouse.wheel(0, 300);
      await page.locator("form input[name=name]").pressSequentially("S");
      await expect.poll(() => beacons(), { timeout: 5_000 }).toEqual(["opened", "started"]);
      const [opened, started] = await beaconBodies(page);
      expect(opened).toEqual({ src: CODE, ref: "AB12cd", step: "opened", trigger: "wheel" });
      expect(started).toEqual({ src: CODE, ref: "AB12cd", step: "started", trigger: null });
      await context.close();
    }

    await expect.poll(async () => (await dailyTotals(db, CODE)).map((r) => r.count), { timeout: 15_000 }).toEqual([2]);
    const rows = await dailyTotals(db, CODE);
    expect(rows).toEqual([{ code: CODE, day: poolVisitDay(new Date()), step: "opened", trigger: "wheel", inApp: "none", scanner: false, count: 2 }]);
    expect(JSON.stringify(rows)).not.toMatch(/AB12cd|iPhone|Mozilla|safari|mobile/i);
    await expect.poll(() => count(db, CODE, "started"), { timeout: 15_000 }).toBe(2);
  });

  test("our own staff: nothing in the totals either", async ({ browser, baseURL, db }) => {
    await db.run(`DELETE FROM "PoolVisitDaily" WHERE code = $1`, [CODE]);
    const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    await context.addCookies([{ name: "mt-staff", value: "2", url: baseURL! }]);
    const page = await context.newPage();
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => beacons(), { timeout: 5_000 }).toEqual(["opened"]);
    await page.waitForLoadState("networkidle");
    await settle();
    expect(await dailyTotals(db, CODE)).toEqual([]);
    await context.close();
  });

  test("only well-formed beacons count: an open by time on screen, with no trigger or an unknown one, counts nothing; a start still counts, in the counters only", async ({ request, db }) => {
    await db.run(`DELETE FROM "PoolVisitDaily" WHERE code = $1`, [CODE]);
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    for (const body of [
      { src: CODE, step: "opened", trigger: "visible-time", visibleMs: 5000 },
      { src: CODE, step: "opened" },
      { src: CODE, step: "opened", trigger: "<script>" },
      { src: CODE },
    ]) {
      const res = await request.post("/api/play/visit", { headers: { "user-agent": PERSON }, data: JSON.stringify(body) });
      expect(res.status()).toBe(204);
    }
    const started = await request.post("/api/play/visit", { headers: { "user-agent": PERSON }, data: JSON.stringify({ src: CODE, step: "started", visibleMs: 9e15 }) });
    expect(started.status()).toBe(204);
    await expect.poll(() => count(db, CODE, "started"), { timeout: 15_000 }).toBe(1);
    await settle();
    expect(await count(db, CODE, "opened")).toBe(0);
    expect(await dailyTotals(db, CODE)).toEqual([]);
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
