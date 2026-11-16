/**
 * MatchTime staff test sign-ups (`PoolProfile.staffTest`, 2026-11-16) are in
 * none of the owner's numbers, on the real dev server against the local
 * Postgres (round 2 of #607: mock-only tests are not enough):
 *   - the source codes page's "All time" line for a code;
 *   - the pool funnel page's row for a code, and its CSV.
 * Each code gets one ordinary sign-up and one staff test, both waiting and
 * both confirmed, so a count that still read the staff tests would show 2.
 * No model anywhere: $0.
 */
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import type { TestDb } from "../helpers/test-db";

const CODE = "e2e-staff-excl";
const P = "e2e-staff-excl";

test.describe.configure({ mode: "serial" });

async function seed(db: TestDb) {
  await db.run(`INSERT INTO "PoolCampaign" (code, source, label) VALUES ($1, 'facebook', 'Staff test exclusion') ON CONFLICT DO NOTHING`, [CODE]);
  for (const [n, staffTest] of [
    [1, false],
    [2, true],
  ] as const) {
    await db.run(`INSERT INTO "User" (id, name, email, onboarded, "isActive", "updatedAt") VALUES ($1, $2, $3, true, true, now()) ON CONFLICT DO NOTHING`, [
      `${P}-u${n}`,
      `Staff Excl ${n}`,
      `${P}-u${n}@e2e-test.invalid`,
    ]);
    // A confirmed sign-up.
    await db.run(
      `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt",
         "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "sourceCode", "staffTest", "createdAt", "updatedAt")
       VALUES ($1, $2, 'active', now(), 4, 'whatsapp', $3, now(), 'Staff Excl', 'SM1', 51.36, -0.19, 3, 'campaign', $4, $5, now(), now())`,
      [`${P}-active-${n}`, `${P}-u${n}`, `wamid-${P}-${n}`, CODE, staffTest],
    );
    // A waiting one.
    await db.run(
      `INSERT INTO "PoolProfile" (id, status, "adultConfirmedAt", "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "sourceCode", "staffTest", "createdAt", "updatedAt")
       VALUES ($1, 'pending-verify', now(), 'Staff Excl', 'SM1', 51.36, -0.19, 3, 'campaign', $2, $3, now(), now())`,
      [`${P}-waiting-${n}`, CODE, staffTest],
    );
    for (const kind of ["active", "waiting"]) {
      await db.run(`INSERT INTO "PoolSport" (id, "profileId", sport, "otherName", formats) VALUES ($1, $2, 'football', '', '{}')`, [`${P}-s-${kind}-${n}`, `${P}-${kind}-${n}`]);
    }
  }
}

test.beforeAll(async ({ db }) => {
  await resetDb();
  await db.run(`DELETE FROM "PoolProfile" WHERE "sourceCode" = $1`, [CODE]);
  await seed(db);
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
});
test.afterAll(async ({ db }) => {
  await db.run(`DELETE FROM "PoolProfile" WHERE "sourceCode" = $1`, [CODE]);
  await db.run(`DELETE FROM "User" WHERE id LIKE $1`, [`${P}-u%`]);
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});

// Round 3 of #607: the staff cookie is unsigned. Only a VERIFIED MatchTime
// staff session makes a staff test; a hand-set cookie alone never does.
const SIGNUP = (name: string) => ({
  name,
  area: { kind: "district", district: "SM1" },
  maxMiles: 3,
  availability: [{ day: 2, from: "19:00", to: "22:00" }],
  sports: [{ sport: "football", formats: [7] }],
  language: "en",
  adult: true,
  consent: true,
  source: { c: CODE },
});

test("a sign-up with a hand-set staff cookie and no session is an ordinary one", async ({ browser, baseURL, db }) => {
  const context = await browser.newContext();
  await context.addCookies([{ name: "mt-staff", value: "2", url: baseURL! }]);
  const res = await context.request.post("/api/play/signup", { data: SIGNUP("Cookie Only"), headers: { "x-forwarded-for": "198.51.100.201" } });
  expect(res.status()).toBe(200);
  const answer = (await res.json()) as { code: string; staffTest?: boolean };
  expect(answer.staffTest).toBeUndefined();
  expect(await db.one(`SELECT "staffTest" FROM "PoolProfile" WHERE "confirmCode" = $1`, [answer.code])).toEqual({ staffTest: false });
  await db.run(`DELETE FROM "PoolProfile" WHERE "confirmCode" = $1`, [answer.code]);
  await context.close();
});

test("a sign-up with a MatchTime staff session (no cookie needed) is a staff test", async ({ browser, db }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, U.admin, "/play");
  await context.clearCookies({ name: "mt-staff" });
  const res = await context.request.post("/api/play/signup", { data: SIGNUP("Staff Session"), headers: { "x-forwarded-for": "198.51.100.202" } });
  expect(res.status()).toBe(200);
  const answer = (await res.json()) as { code: string; staffTest?: boolean };
  expect(answer.staffTest).toBe(true);
  expect(await db.one(`SELECT "staffTest" FROM "PoolProfile" WHERE "confirmCode" = $1`, [answer.code])).toEqual({ staffTest: true });
  await db.run(`DELETE FROM "PoolProfile" WHERE "confirmCode" = $1`, [answer.code]);
  await context.close();
});

test("the source codes page counts only the ordinary sign-ups, all time", async ({ page, db }) => {
  expect(await db.one(`SELECT count(*)::int AS n FROM "PoolProfile" WHERE "sourceCode" = $1 AND "staffTest"`, [CODE])).toEqual({ n: 2 });
  await signInAs(page, U.admin, "/admin/pool/campaigns");
  const row = page.locator(`[data-testid="campaign-row"][data-code="${CODE}"]`);
  await expect(row.getByTestId("campaign-alltime")).toHaveText("All time: 2 sign-ups, 1 confirmed, 1 still waiting.", { timeout: 30_000 });
});

test("the pool funnel page and its CSV count only the ordinary sign-ups", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/pool/funnel");
  const row = page.locator(`[data-testid="funnel-campaign"][data-code="${CODE}"]`);
  await expect(row.locator('td[data-step="signedUp"]')).toHaveText("2", { timeout: 30_000 });
  await expect(row.locator('td[data-step="verified"]')).toHaveText("1");
  await expect(row.locator('td[data-step="active"]')).toHaveText("1");

  const csvUrl = await page.getByTestId("funnel-csv").getAttribute("href");
  const csv = await (await page.request.get(csvUrl!)).text();
  const line = csv.split(/\r?\n/).find((l) => l.startsWith(`${CODE},`));
  expect(line, csv).toBeDefined();
  // Signed up 2, confirmed 1, active 1: with the staff tests it would be 4, 2, 2.
  expect(line!.startsWith(`${CODE},Staff test exclusion,2,1,1,`)).toBe(true);
});
