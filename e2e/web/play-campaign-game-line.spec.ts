/**
 * /play from a Facebook post (2026-11-11): the headline is "Join the free
 * local player list" for everyone, and a link with ?src=fb, fb1 or fb2
 * names the game its post sells (Sutton FC's next upcoming match) at the
 * top, while that game has a place. A Nextdoor link (?src=nd) does the same
 * (2026-11-13), and under the line Sutton FC's offer reads "First game free
 * for new players". Another code, or a full game, shows neither. The club is made in the test database with Sutton FC's id, since
 * the codes are mapped to that id in code (`campaign-game-line.ts`).
 *
 * Review fixes (2026-11-15): a code names the game only while its
 * PoolCampaign row is live, so the seed makes fb, fb1, fb2 and nd live
 * campaigns and a switched-off code shows nothing; this week's game is
 * still named once its teams are made; and while sign-ups are paused
 * (the page's MT_TEST_MODE cookie, `flags-page.ts`) neither shows.
 * No model anywhere: $0.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { U } from "../helpers/constants";
import { E2E_BASE_URL } from "../helpers/env";
import { POOL_SIGNUP_PAUSED_TEST_COOKIE } from "@/lib/pool/flags";
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

const GAME_CODES = ["fb", "fb1", "fb2", "nd"] as const;

/** Sutton FC with one match three days out, 7-a-side (upcoming unless
 *  `status` says otherwise), and fb, fb1, fb2 and nd as live campaigns. */
async function seedSutton(db: TestDb, o: { status?: "UPCOMING" | "TEAMS_GENERATED" } = {}): Promise<Date> {
  for (const code of GAME_CODES) {
    await db.run(
      `INSERT INTO "PoolCampaign" (code, source, label, active) VALUES ($1, $2, 'Game line e2e', true) ON CONFLICT (code) DO UPDATE SET active = true`,
      [code, code === "nd" ? "nextdoor" : "facebook"],
    );
  }
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
    `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, 'e2e-sutton-activity', $2, 14, $3::"MatchStatus", $4, now())`,
    [MATCH_ID, date, o.status ?? "UPCOMING", new Date(date.getTime() - 5 * 3600_000)],
  );
  return date;
}

const line = (page: Page) => page.getByTestId("pool-game-line");
const offer = (page: Page) => page.getByTestId("pool-game-offer");
const expectedLine = (date: Date) =>
  campaignGameLine({ code: "fb1", match: { date, maxPlayers: 14, venue: "Goals North Cheam", placesOpen: 14 }, now: new Date(), lang: "en" })!;

test("the headline is the free local player list", async ({ page }) => {
  await page.goto("/play");
  await expect(page.getByRole("heading", { level: 1, name: "Join the free local player list" })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
});

test("a Facebook link names Sutton FC's next game; another code does not", async ({ page, db }) => {
  const date = await seedSutton(db);
  const expected = campaignGameLine({ code: "fb1", match: { date, maxPlayers: 14, venue: "Goals North Cheam", placesOpen: 14 }, now: new Date(), lang: "en" })!;
  expect(expected).toMatch(/^\w+day 7-a-side in Sutton: \w{3} \d{1,2} \w{3}, \d{1,2}(:\d{2})?[ap]m, Goals North Cheam$/);

  for (const src of ["fb", "fb1", "fb2", "nd"]) {
    await page.goto(`/play?src=${src}`);
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect(line(page)).toHaveText(expected);
    await expect(offer(page)).toHaveText("First game free for new players");
  }

  for (const src of ["fb3", "os", "lf", "site-hero"]) {
    await page.goto(`/play?src=${src}`);
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expect(offer(page)).toHaveCount(0);
  }
});

test("no link code: no game line and no offer, even with a game", async ({ page, db }) => {
  await seedSutton(db);
  await page.goto("/play");
  await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await expect(offer(page)).toHaveCount(0);
});

test("a full game: no line and no offer, from Facebook or Nextdoor", async ({ page, db }) => {
  const date = await seedSutton(db);
  // The campaigns are live and the game is named while it has a place, so
  // what takes the line away below is the game filling, nothing else.
  await page.goto("/play?src=fb1");
  await expect(line(page)).toHaveText(expectedLine(date));
  await db.run(`UPDATE "Match" SET "maxPlayers" = 2 WHERE id = $1`, [MATCH_ID]);
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ('e2e-fb-att-1', $1, $2, 'CONFIRMED', 1, now()), ('e2e-fb-att-2', $1, $3, 'CONFIRMED', 2, now())`,
    [MATCH_ID, U.admin, U.player],
  );
  for (const src of ["fb1", "nd"]) {
    await page.goto(`/play?src=${src}`);
    await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expect(offer(page)).toHaveCount(0);
  }
});

test("a code whose campaign is switched off: no line and no offer", async ({ page, db }) => {
  const date = await seedSutton(db);
  await db.run(`UPDATE "PoolCampaign" SET active = false WHERE code = 'fb2'`);
  await page.goto("/play?src=fb2");
  await expect(page.getByRole("heading", { level: 1, name: EN.signup.heading })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await expect(offer(page)).toHaveCount(0);
  // The other codes, still live, name the game.
  await page.goto("/play?src=fb1");
  await expect(line(page)).toHaveText(expectedLine(date));
});

test("this week's game with its teams made is still the one named", async ({ page, db }) => {
  const date = await seedSutton(db, { status: "TEAMS_GENERATED" });
  await page.goto("/play?src=nd");
  await expect(line(page)).toHaveText(expectedLine(date));
  await expect(offer(page)).toHaveText("First game free for new players");
});

test("sign-ups paused: the paused note, and no line and no offer", async ({ page, db }) => {
  await seedSutton(db);
  await page.context().addCookies([{ name: POOL_SIGNUP_PAUSED_TEST_COOKIE, value: "1", url: E2E_BASE_URL }]);
  for (const src of ["fb1", "nd"]) {
    await page.goto(`/play?src=${src}`);
    await expect(page.getByText(EN.signup.pausedNote)).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expect(offer(page)).toHaveCount(0);
  }
});
