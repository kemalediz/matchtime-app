/**
 * The /play sign-up funnel (2026-11-04), end to end on the real dev server:
 *   - opening /play counts "opened" once per tab session (as since
 *     2026-11-03), but only once a person shows he is there (2026-11-12,
 *     after link scanners): a tap, a key, a wheel or a scroll, or 5 seconds
 *     on screen; a page nobody touches for less counts nothing, and typing
 *     first counts opened before started;
 *   - our own staff count nothing (2026-11-12): a browser that loaded an
 *     /admin page as an owner or admin carries the staff cookie;
 *   - the first time a person enters something in the
 *     form (types a character, ticks a box) counts "started" once per tab
 *     session, under the same code; focus, clicks and a script's synthetic
 *     events count nothing (2026-11-06, after a scanner);
 *   - a fetcher calling the beacon counts nothing, and a page claiming the
 *     server's steps (sent, confirmed) counts nothing;
 *   - each beacon carries what opened the page and its time on screen, and
 *     the visit log (2026-11-13, kept 90 days) keeps them with a coarse
 *     browser label and nothing that identifies the visitor; a fetcher is
 *     logged as a scanner, our staff not at all;
 *   - the owner's source codes page shows opened, started, sent and
 *     confirmed for today, 7 days or 30 days, with the drop between steps.
 * The server's own steps (sent, confirmed) are e2e/sim/pool/funnel-steps.spec.ts.
 * No model anywhere: $0.
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

type VisitEvent = {
  at: Date;
  code: string;
  step: string;
  openedBy: string | null;
  visibleMs: number | null;
  hasRef: boolean;
  browser: string;
  inApp: string;
  device: string;
  scanner: boolean;
};
const visitEvents = (db: TestDb, code: string) =>
  db.all<VisitEvent>(
    `SELECT "at", "code", "step", "openedBy", "visibleMs", "hasRef", "browser", "inApp", "device", "scanner" FROM "PoolVisitEvent" WHERE code = $1 ORDER BY "step", "at"`,
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
    // Nobody touches it: opened after 5 seconds on screen.
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

  test("a load nobody touches for under 5 seconds counts no open", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.waitForTimeout(3_000);
    expect(await beacons()).toEqual([]);
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
      // Well inside the 5 seconds: the scroll or tap counted, not the clock.
      await expect.poll(() => count(db, CODE, "opened"), { timeout: 3_000 }).toBe(n);
      await page.mouse.wheel(0, 300);
      await settle();
      expect(await count(db, CODE, "opened")).toBe(n);
      await context.close();
    }
  });

  test("5 seconds on screen counts one open, not sooner", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    const shown = Date.now();
    await expect.poll(async () => (await beacons()).length, { timeout: 15_000 }).toBe(1);
    expect(Date.now() - shown).toBeGreaterThanOrEqual(4_500);
    await expect.poll(() => count(db, CODE, "opened"), { timeout: 15_000 }).toBe(1);
    expect(await beacons()).toEqual(["opened"]);
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
    await expect.poll(() => count(db, CODE, "started"), { timeout: 15_000 }).toBe(1);
    expect(await count(db, CODE, "opened")).toBe(1);
  });

  test("a browser with the staff cookie counts nothing, though the page still sends", async ({ browser, baseURL, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    await context.addCookies([{ name: "mt-staff", value: "1", url: baseURL! }]);
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

  test("an owner who loads /admin gets the staff cookie and his /play visit counts nothing; a player gets none", async ({ browser, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit" WHERE code = $1`, [CODE]);
    const owner = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    const page = await owner.newPage();
    await signInAs(page, U.admin, "/admin");
    await expect.poll(async () => (await owner.cookies()).find((c) => c.name === "mt-staff")?.value, { timeout: 30_000 }).toBe("1");
    const cookie = (await owner.cookies()).find((c) => c.name === "mt-staff")!;
    expect(cookie.path).toBe("/");
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.expires * 1000 - Date.now()).toBeGreaterThan(360 * 86_400_000);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await page.waitForLoadState("networkidle");
    await settle();
    expect(await count(db, CODE, "opened")).toBe(0);
    await owner.close();

    const player = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    const playerPage = await player.newPage();
    await signInAs(playerPage, U.player, "/admin");
    await playerPage.waitForLoadState("networkidle");
    expect((await player.cookies()).find((c) => c.name === "mt-staff")).toBeUndefined();
    await player.close();
  });

  test("a fetcher's beacon counts nothing, and a page cannot claim the server's steps", async ({ request, db }) => {
    await db.run(`DELETE FROM "PoolCampaignVisit"`);
    await db.run(`DELETE FROM "PoolVisitEvent"`);
    const fetcher = await request.post("/api/play/visit", { headers: { "user-agent": FACEBOOK }, data: JSON.stringify({ src: CODE, step: "started" }) });
    expect(fetcher.status()).toBe(204);
    for (const step of ["sent", "confirmed"]) {
      const res = await request.post("/api/play/visit", { headers: { "user-agent": PERSON }, data: JSON.stringify({ src: CODE, step }) });
      expect(res.status()).toBe(204);
    }
    await settle();
    expect(await db.one(`SELECT count(*)::int AS n FROM "PoolCampaignVisit"`)).toEqual({ n: 0 });
    // The fetcher is in the visit log as a scanner (2026-11-13), and only it.
    expect(await visitEvents(db, CODE)).toEqual([expect.objectContaining({ step: "started", scanner: true, device: "other", inApp: "none" })]);
    expect(await db.one(`SELECT count(*)::int AS n FROM "PoolVisitEvent"`)).toEqual({ n: 1 });
  });
});

test.describe("the visit log, kept 90 days (2026-11-13)", () => {
  test.use({ userAgent: PERSON, locale: "en-GB" });

  test.beforeAll(async ({ db }) => {
    await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Funnel web e2e') ON CONFLICT DO NOTHING`, [CODE]);
  });

  test("the table holds only the funnel's fields: no address, user agent, friend's code, user id or cookie", async ({ db }) => {
    const cols = await db.all<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'PoolVisitEvent' ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(["at", "browser", "code", "device", "hasRef", "id", "inApp", "openedBy", "scanner", "step", "visibleMs"]);
  });

  test("a scroll then typing: each beacon carries what opened the page and its time on screen, and the log keeps them with a coarse label", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolVisitEvent" WHERE code = $1`, [CODE]);
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}&ref=AB12cd`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await page.locator("form input[name=name]").pressSequentially("S");
    await expect.poll(() => beacons(), { timeout: 5_000 }).toEqual(["opened", "started"]);

    const [opened, started] = await beaconBodies(page);
    expect(opened).toMatchObject({ src: CODE, ref: "AB12cd", step: "opened", trigger: "wheel" });
    expect(started).toMatchObject({ step: "started", trigger: null });
    for (const b of [opened, started]) {
      expect(Number.isInteger(b.visibleMs)).toBe(true);
      expect(b.visibleMs as number).toBeGreaterThanOrEqual(0);
      expect(b.visibleMs as number).toBeLessThan(5_000);
    }
    expect(started.visibleMs as number).toBeGreaterThanOrEqual(opened.visibleMs as number);

    await expect.poll(async () => (await visitEvents(db, CODE)).length, { timeout: 15_000 }).toBe(2);
    const rows = await visitEvents(db, CODE);
    const label = { code: CODE, hasRef: true, browser: "safari", inApp: "none", device: "mobile", scanner: false };
    expect(rows[0]).toMatchObject({ ...label, step: "opened", openedBy: "wheel" });
    expect(rows[1]).toMatchObject({ ...label, step: "started", openedBy: null });
    for (const r of rows) {
      expect(r.visibleMs! % 100).toBe(0);
      expect(new Date(r.at).getUTCSeconds()).toBe(0);
      expect(JSON.stringify(r)).not.toMatch(/AB12cd|iPhone|Mozilla/);
    }
  });

  test("5 seconds on screen: opened by the clock, with about 5 seconds on screen", async ({ page, db }) => {
    await db.run(`DELETE FROM "PoolVisitEvent" WHERE code = $1`, [CODE]);
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await expect.poll(() => beacons(), { timeout: 15_000 }).toEqual(["opened"]);
    const [opened] = await beaconBodies(page);
    expect(opened.trigger).toBe("visible-time");
    expect(opened.visibleMs as number).toBeGreaterThanOrEqual(4_500);
    await expect.poll(async () => (await visitEvents(db, CODE)).map((r) => [r.openedBy, r.hasRef]), { timeout: 15_000 }).toEqual([["visible-time", false]]);
  });

  test("our own staff: nothing in the log either", async ({ browser, baseURL, db }) => {
    await db.run(`DELETE FROM "PoolVisitEvent" WHERE code = $1`, [CODE]);
    const context = await browser.newContext({ userAgent: PERSON, locale: "en-GB" });
    await context.addCookies([{ name: "mt-staff", value: "1", url: baseURL! }]);
    const page = await context.newPage();
    const beacons = await watchBeacons(page);
    await page.goto(`/play?src=${CODE}`);
    await hydrated(page);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => beacons(), { timeout: 5_000 }).toEqual(["opened"]);
    await page.waitForLoadState("networkidle");
    await settle();
    expect(await visitEvents(db, CODE)).toEqual([]);
    await context.close();
  });

  test("a body out of bounds is clamped, an unknown trigger dropped", async ({ request, db }) => {
    await db.run(`DELETE FROM "PoolVisitEvent" WHERE code = $1`, [CODE]);
    const res = await request.post("/api/play/visit", {
      headers: { "user-agent": PERSON },
      data: JSON.stringify({ src: CODE, step: "opened", trigger: "<script>", visibleMs: 9e15 }),
    });
    expect(res.status()).toBe(204);
    await expect.poll(async () => (await visitEvents(db, CODE)).map((r) => [r.openedBy, r.visibleMs]), { timeout: 15_000 }).toEqual([[null, 86_400_000]]);
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
