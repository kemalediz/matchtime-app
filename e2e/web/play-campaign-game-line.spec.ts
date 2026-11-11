/**
 * /play from a Facebook post (2026-11-11): the headline is "Join the free
 * local player list" for everyone, and a link with ?src=fb, fb1 or fb2
 * names the game its post sells (Sutton FC's next upcoming match) at the
 * top, while that game has a place. Another code, or a full game, shows no
 * line. The club is made in the test database with Sutton FC's id, since
 * the codes are mapped to that id in code (`campaign-game-line.ts`).
 * No model anywhere: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { U } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";
import { poolPageCopy } from "@/lib/pool/page-copy";
import { campaignGameClub, campaignGameLine } from "@/lib/pool/campaign-game-line";

const EN = poolPageCopy("en");
const SUTTON = campaignGameClub("fb1")!;
const MATCH_ID = "e2e-fb-sutton-match";

test.use({ locale: "en-GB" });
test.describe.configure({ mode: "serial" });
test.beforeEach(() => resetDb());
test.afterAll(() => resetDb());

/** Sutton FC with one upcoming match three days out, 7-a-side. */
async function seedSutton(db: TestDb): Promise<Date> {
  const date = new Date(Date.now() + 3 * 24 * 3600_000);
  date.setUTCSeconds(0, 0);
  await db.run(`INSERT INTO "Organisation" (id, name, slug, "inviteCode", "updatedAt") VALUES ($1, 'Sutton Football Club', 'e2e-sutton-fc', 'e2e-sutton-invite', now())`, [SUTTON.orgId]);
  await db.run(
    `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt") VALUES ('e2e-sutton-sport', $1, 'Football 7-a-side', 7, ARRAY['GK','DEF','MID','FWD'], ARRAY['Red','Yellow'], now())`,
    [SUTTON.orgId],
  );
  await db.run(
    `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "updatedAt") VALUES ('e2e-sutton-activity', $1, 'e2e-sutton-sport', 'Tuesday 7-a-side', 2, '21:30', 'Goals North Cheam', now())`,
    [SUTTON.orgId],
  );
  await db.run(
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, 'e2e-sutton-activity', $2, 14, 'UPCOMING', $3, now())`,
    [MATCH_ID, date, new Date(date.getTime() - 5 * 3600_000)],
  );
  return date;
}

const line = (page: Page) => page.getByTestId("pool-game-line");

test("the headline is the free local player list", async ({ page }) => {
  await page.goto("/play");
  await expect(page.getByRole("heading", { level: 1, name: "Join the free local player list" })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
});

test("a Facebook link names Sutton FC's next game; another code does not", async ({ page, db }) => {
  const date = await seedSutton(db);
  const expected = campaignGameLine({ code: "fb1", match: { date, maxPlayers: 14, venue: "Goals North Cheam", placesOpen: 14 }, now: new Date(), lang: "en" })!;
  expect(expected).toMatch(/^\w+day 7-a-side in Sutton: \w{3} \d{1,2} \w{3}, \d{1,2}(:\d{2})?[ap]m, Goals North Cheam$/);

  for (const src of ["fb", "fb1", "fb2"]) {
    await page.goto(`/play?src=${src}`);
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect(line(page)).toHaveText(expected);
  }

  for (const src of ["fb3", "nd", "site-hero"]) {
    await page.goto(`/play?src=${src}`);
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect(line(page)).toHaveCount(0);
  }
});

test("a full game: no line", async ({ page, db }) => {
  await seedSutton(db);
  await db.run(`UPDATE "Match" SET "maxPlayers" = 2 WHERE id = $1`, [MATCH_ID]);
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ('e2e-fb-att-1', $1, $2, 'CONFIRMED', 1, now()), ('e2e-fb-att-2', $1, $3, 'CONFIRMED', 2, now())`,
    [MATCH_ID, U.admin, U.player],
  );
  await page.goto("/play?src=fb1");
  await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
});
