/**
 * Growth slice G2 of the local player pool, in a real browser: the owner's
 * funnel dashboard at /admin/pool/funnel.
 *   - a club admin sees no tab and gets 404 on the page and on the CSV;
 *   - the owner sees the funnel (counts, conversions, the drawn chart),
 *     weeks, sources, campaign codes, the early sign-up list and offer
 *     health, at phone and desktop width with no sideways scroll;
 *   - filters (dates, town, sport, source) change the counts;
 *   - the CSV download carries the same numbers;
 *   - an empty range says so;
 *   - no name, number or share code reaches the page or the CSV.
 * No model anywhere: $0.
 *
 * The world (sign-ups two days ago unless noted):
 *   F1  waiting for his WhatsApp message (web)
 *   F2  confirmed, active, campaign e2e-funnel-li, town sutton, early list
 *   F3  confirmed then stopped, a friend's referral (share code SECRET9)
 *   F4  campaign e2e-funnel-li, padel: offered, accepted, played the rate
 *       match as a pool guest, now a member of the club
 *   F5  signed up 400 days ago (outside the default range)
 * Offer health: one quiet-hour hold and one week-cap refusal.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { MATCH, ORG_ID } from "../helpers/constants";

const MOBILE = { width: 375, height: 740 };
const DESKTOP = { width: 1280, height: 900 };
const P = "e2e-funnel";
const CODE = "e2e-funnel-li";
const SECRETS = ["Secret Funnelname", "+447700900971", "7700900971", "SECRET9", "SM7"];
const DAY = 24 * 3600_000;

test.describe.configure({ mode: "serial" });

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function seed(db: TestDb) {
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  for (const n of [2, 3, 4, 5]) {
    await db.run(`INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`, [
      `${P}-u${n}`,
      `Secret Funnelname ${n}`,
      `${P}-u${n}@e2e-test.invalid`,
      `+44770090097${n === 2 ? 1 : n}`,
    ]);
  }
  await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'linkedin', 'LinkedIn post')`, [CODE]);

  const profile = async (
    n: number,
    o: { status: string; userId: string | null; source: string; sourceCode?: string; town?: string; early?: boolean; created: Date; sport: string },
  ) => {
    const live = o.status !== "pending-verify";
    await db.run(
      `INSERT INTO "PoolProfile" (id,"userId",status,"stoppedAt","consentAt","consentVersion","consentChannel","consentEvidence","adultConfirmedAt",
         "displayName","areaDistrict","areaLat","areaLng","maxMiles",source,"sourceCode",town,"earlyList","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'Secret Funnelname','SM7',51.36,-0.19,3,$9,$10,$11,$12,$13,now())`,
      [
        `${P}-p${n}`,
        o.userId,
        o.status,
        o.status === "stopped" ? new Date() : null,
        live ? new Date() : null,
        live ? 1 : null,
        live ? "whatsapp" : null,
        live ? `wamid-${P}-${n}` : null,
        o.source,
        o.sourceCode ?? null,
        o.town ?? null,
        o.early ?? false,
        o.created,
      ],
    );
    await db.run(`INSERT INTO "PoolSport" (id,"profileId",sport,"otherName",formats) VALUES ($1,$2,$3,'','{}')`, [`${P}-s${n}`, `${P}-p${n}`, o.sport]);
  };
  await profile(1, { status: "pending-verify", userId: null, source: "web", created: ago(2), sport: "football" });
  await profile(2, { status: "active", userId: `${P}-u2`, source: "campaign", sourceCode: CODE, town: "sutton", early: true, created: ago(2), sport: "football" });
  await profile(3, { status: "stopped", userId: `${P}-u3`, source: "referral", sourceCode: "SECRET9", created: ago(2), sport: "football" });
  await profile(4, { status: "active", userId: `${P}-u4`, source: "campaign", sourceCode: CODE, created: ago(2), sport: "padel" });
  await profile(5, { status: "active", userId: `${P}-u5`, source: "web", created: ago(400), sport: "football" });

  // F4: offered (delivered), accepted, played the rate match, kept as a member.
  await db.run(`INSERT INTO "PoolAsk" (id,"matchId","orgId",places,via,status,"closedAt","updatedAt") VALUES ($1,$2,$3,1,'page','filled',now(),now())`, [
    `${P}-k1`,
    MATCH.rate,
    ORG_ID,
  ]);
  await db.run(
    `INSERT INTO "PoolOffer" (id,"poolAskId","matchId","orgId","userId","distanceMiles","sentAt","expiresAt",outcome,"resolvedAt") VALUES ($1,$2,$3,$4,$5,1.2,$6,now(),'accepted',now())`,
    [`${P}-o1`, `${P}-k1`, MATCH.rate, ORG_ID, `${P}-u4`, ago(1)],
  );
  await db.run(
    `INSERT INTO "GuestPlace" (id,"orgId","matchId","userId",source,"poolOfferId",result,"resultAt","updatedAt") VALUES ($1,$2,$3,$4,'pool',$5,'played',now(),now())`,
    [`${P}-g1`, ORG_ID, MATCH.rate, `${P}-u4`, `${P}-o1`],
  );
  await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ($1,$2,$3,'CONFIRMED',9,now(),now())`, [
    `${P}-a1`,
    MATCH.rate,
    `${P}-u4`,
  ]);
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'PLAYER',now())`, [`${P}-m1`, `${P}-u4`, ORG_ID]);

  // Offer health: one DM held for quiet hours, one refused by the week cap.
  await db.run(
    `INSERT INTO "PlatformJob" (id,kind,purpose,status,"sendAfter","createdAt","updatedAt") VALUES ($1,'dm','pool-offer','sent',$2,$3,now())`,
    [`${P}-j1`, ago(1), ago(1.2)],
  );
  await db.run(
    `INSERT INTO "PlatformJob" (id,kind,purpose,status,"failedAt","failReason","createdAt","updatedAt") VALUES ($1,'dm','pool-offer','failed',$2,'cancelled: pool offer week-cap',$2,now())`,
    [`${P}-j2`, ago(1)],
  );
}

test.beforeAll(async () => {
  resetDb();
});
test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

const stepCount = (page: Page, step: string) => page.locator(`[data-testid="funnel-step"][data-step="${step}"]`).getByTestId("funnel-step-count");
const stepConversion = (page: Page, step: string) => page.locator(`[data-testid="funnel-step"][data-step="${step}"]`).getByTestId("funnel-step-conversion");

test("a club admin: no Pool funnel tab, the page and the CSV answer 404", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: "Pool funnel", exact: true })).toHaveCount(0);

  expect((await page.goto("/admin/pool/funnel"))?.status()).toBe(404);
  await expect(page.getByText("Player pool funnel")).toHaveCount(0);
  const csv = await page.request.get("/admin/pool/funnel/funnel.csv");
  expect(csv.status()).toBe(404);
  expect(csv.headers()["content-type"]).not.toContain("text/csv");
});

test.describe("the owner", () => {
  test.beforeAll(async ({ db }) => {
    await seed(db);
  });
  test.beforeEach(async ({ db }) => {
    await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  });

  test("sees the Pool funnel tab", async ({ page }) => {
    await signInAs(page, U.admin, "/admin");
    await expect(page.getByRole("link", { name: "Pool funnel", exact: true })).toBeVisible({ timeout: 30_000 });
  });

  for (const [name, size] of [["phone", MOBILE], ["desktop", DESKTOP]] as const) {
    test(`${name}: the funnel, weeks, sources, campaign codes, early list and offer health`, async ({ page }) => {
      await page.setViewportSize(size);
      await signInAs(page, U.admin, "/admin/pool/funnel");
      await expect(page.getByRole("heading", { name: "Player pool funnel" })).toBeVisible({ timeout: 30_000 });

      const expected: Record<string, [string, string]> = {
        signedUp: ["4", "-"],
        verified: ["3", "75%"],
        active: ["2", "67%"],
        offered: ["1", "50%"],
        accepted: ["1", "100%"],
        played: ["1", "100%"],
        becameMembers: ["1", "100%"],
      };
      for (const [step, [count, conv]] of Object.entries(expected)) {
        await expect(stepCount(page, step)).toHaveText(count);
        await expect(stepConversion(page, step)).toHaveText(conv);
      }
      // The drawn chart: one bar per step, carrying its count.
      const bars = page.getByTestId("funnel-chart").locator('[data-testid="funnel-bar"]');
      await expect(bars).toHaveCount(7);
      await expect(page.locator('[data-testid="funnel-bar"][data-step="verified"]')).toHaveAttribute("data-count", "3");

      await expect(page.getByTestId("funnel-overall")).toHaveText("25%");
      await expect(page.getByTestId("funnel-early-list")).toHaveText("1");

      // 12 weeks, every one listed, this week's sign-ups split by source.
      await expect(page.getByTestId("funnel-week")).toHaveCount(12);
      const weeks = page.getByTestId("funnel-week");
      const signedUpCells = await weeks.evaluateAll((rows) => rows.map((r) => Number(r.querySelectorAll("td")[1]?.textContent)));
      expect(signedUpCells.reduce((a, b) => a + b, 0)).toBe(4);

      const source = (s: string) => page.locator(`[data-testid="funnel-source"][data-source="${s}"] td[data-step="signedUp"]`);
      await expect(source("web")).toHaveText("1");
      await expect(source("referral")).toHaveText("1");
      await expect(source("campaign")).toHaveText("2");
      const campaign = page.locator(`[data-testid="funnel-campaign"][data-code="${CODE}"]`);
      await expect(campaign).toContainText("LinkedIn post");
      await expect(campaign.locator('td[data-step="becameMembers"]')).toHaveText("1");

      const health = page.getByTestId("funnel-health");
      await expect(health.getByTestId("funnel-health-item").filter({ hasText: "Held for quiet hours" })).toContainText("1");
      await expect(health.getByTestId("funnel-health-item").filter({ hasText: "Caps hit: two a week" })).toContainText("1");
      await expect(health.getByTestId("funnel-health-item").filter({ hasText: "Offers delivered" })).toContainText("1");

      const text = await page.locator("body").innerText();
      for (const s of SECRETS) expect(text).not.toContain(s);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test("filters: source, one campaign code, town, sport and the dates change the counts", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, U.admin, "/admin/pool/funnel");
    await expect(stepCount(page, "signedUp")).toHaveText("4", { timeout: 30_000 });

    await page.getByLabel("Source", { exact: true }).selectOption("campaign");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/source=campaign/);
    await expect(stepCount(page, "signedUp")).toHaveText("2");
    await expect(stepCount(page, "becameMembers")).toHaveText("1");

    await page.getByLabel("Source", { exact: true }).selectOption(`campaign:${CODE}`);
    await page.getByLabel("Sport", { exact: true }).selectOption("padel");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(stepCount(page, "signedUp")).toHaveText("1");

    await page.getByLabel("Source", { exact: true }).selectOption("");
    await page.getByLabel("Sport", { exact: true }).selectOption("");
    await page.getByLabel("Town", { exact: true }).selectOption("sutton");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(stepCount(page, "signedUp")).toHaveText("1");
    await expect(page.getByTestId("funnel-early-list")).toHaveText("1");

    // Back far enough to take in F5 too.
    await page.getByLabel("Town", { exact: true }).selectOption("");
    const from = new Date(Date.now() - 401 * DAY).toISOString().slice(0, 10);
    await page.getByLabel("From", { exact: true }).fill(from);
    await page.getByRole("button", { name: "Show" }).click();
    await expect(stepCount(page, "signedUp")).toHaveText("5");
  });

  test("an empty range says so, and offer health and the early list still show", async ({ page }) => {
    for (const size of [MOBILE, DESKTOP]) {
      await page.setViewportSize(size);
      await signInAs(page, U.admin, "/admin/pool/funnel?from=2020-01-01&to=2020-01-31");
      await expect(page.getByTestId("funnel-empty")).toHaveText("Nobody signed up between these dates with these filters.", { timeout: 30_000 });
      await expect(page.getByTestId("funnel-chart")).toHaveCount(0);
      await expect(page.getByTestId("funnel-early-list")).toHaveText("1");
      await expect(page.getByTestId("funnel-health-item")).toHaveCount(8);
      await expect(page.getByTestId("funnel-overall")).toHaveText("None");
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    }
  });

  test("the CSV download carries the same numbers and the filters, and no names", async ({ page }) => {
    await signInAs(page, U.admin, "/admin/pool/funnel?source=campaign");
    await expect(stepCount(page, "signedUp")).toHaveText("2", { timeout: 30_000 });
    const download = page.waitForEvent("download");
    await page.getByTestId("funnel-csv").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^pool-funnel-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync((await file.path())!, "utf8").replace(/^﻿/, "");
    const lines = csv.split("\r\n");
    expect(lines[0]).toMatch(/^Pool funnel,From \d{4}-\d{2}-\d{2},To \d{4}-\d{2}-\d{2},Town: all,Sport: all,Source: Campaign$/);
    expect(lines).toContain("Signed up,2,");
    expect(lines).toContain("Became members,1,100%");
    expect(lines.some((l) => l.startsWith(`${CODE},LinkedIn post,2,`))).toBe(true);
    expect(lines).toContain("Held for quiet hours,1");
    expect(lines).toContain("Early sign-up list,1");
    for (const s of SECRETS) expect(csv).not.toContain(s);
  });
});
