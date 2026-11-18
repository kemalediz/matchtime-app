/**
 * MAN OF THE MATCH ON THE WEB (review of #608, round 2). The dashboard, the
 * matches list, the match page, the admin stats and the player's own stats
 * read the same decision as the group: an OPEN vote shows no leader and no
 * counts, and a POSTED result shows what was announced, even when the votes
 * moved after the post.
 *
 * The fixture's MATCH.rate was played yesterday at 20:00 London (a 120h
 * vote, so still open) and scored 3-2. Olivia leads its votes.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, NAME } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const vote = (db: { run: (sql: string, a: unknown[]) => Promise<unknown> }, voter: string, player: string) =>
  db.run(`INSERT INTO "MoMVote" (id, "matchId", "voterId", "playerId") VALUES ($1, $2, $3, $4)`, [`e2e-web-mom-${voter}`, MATCH.rate, voter, player]);

test.beforeAll(async ({ db }) => {
  resetDb();
  // Olivia 3, Tom 1: an open vote, Olivia ahead.
  for (const v of [U.rater, U.player, U.stale]) await vote(db, v, U.opt);
  await vote(db, U.opt, U.third);
});

test.afterAll(async () => {
  resetDb();
});

test("an OPEN vote: the match page, the dashboard and the matches list show no leader and no counts", async ({ page }) => {
  await signInAs(page, U.player, `/matches/${MATCH.rate}`);
  const mom = page.getByTestId("match-mom");
  await expect(mom).toBeVisible({ timeout: 30_000 });
  await expect(mom).toContainText("Voting open");
  await expect(mom).not.toContainText(NAME.opt);
  await expect(mom).not.toContainText(/vote(s)? each|of \d+ vote|received votes|voted/);

  await page.goto("/");
  const recent = page.getByTestId("recent-result").filter({ hasText: "Voting open" });
  await expect(recent).toHaveCount(1);
  await expect(page.getByTestId("recent-result").filter({ hasText: NAME.opt })).toHaveCount(0);

  await page.goto("/matches");
  await page.getByRole("button", { name: /^Past \(/ }).click();
  await expect(page.getByTestId("past-result").filter({ hasText: "Voting open" })).toHaveCount(1);
  await expect(page.getByTestId("past-result").filter({ hasText: NAME.opt })).toHaveCount(0);
});

test("an OPEN vote: the leader's own dashboard tile and stats, and the admin stats, credit no Man of the Match", async ({ page }) => {
  // Round 3: the dashboard's own MoM tile counted open votes the user led.
  await signInAs(page, U.opt, "/");
  await expect(page.getByTestId("dashboard-mom-wins")).toHaveText("0", { timeout: 30_000 });

  await page.goto("/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  const tile = page.locator("div.rounded-2xl").filter({ has: page.getByText("Man of the Match", { exact: true }) }).first();
  await expect(tile).toBeVisible();
  await expect(tile.locator("div").first()).toHaveText("0");
  await expect(tile).not.toContainText("👑");

  await signInAs(page, U.admin, "/admin/stats");
  const row = page.getByTestId("admin-stat-player").filter({ hasText: NAME.opt });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("admin-stat-mom")).toHaveText("0 MoM wins");
  // The column says what it counts.
  await expect(page.getByTestId("admin-stat-mom-note")).toContainText("decided results only");
});

test("POSTED, then the votes moved: every page shows what was announced", async ({ page, db }) => {
  // The post said Tom 2, Olivia 1; the votes have since moved to Olivia.
  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId") VALUES ('e2e-web-mom-sn', $1, 'group-message', $2, 'wa-e2e-web-mom')`, [`${MATCH.rate}:mom-announcement`, MATCH.rate]);
  await db.run(`INSERT INTO "MoMAnnouncement" ("matchId", result) VALUES ($1, $2::jsonb)`, [
    MATCH.rate,
    JSON.stringify({ v: 1, kind: "vote", tally: [{ userId: U.third, name: NAME.third, votes: 2 }, { userId: U.opt, name: NAME.opt, votes: 1 }] }),
  ]);

  await signInAs(page, U.player, `/matches/${MATCH.rate}`);
  const mom = page.getByTestId("match-mom");
  await expect(mom).toBeVisible({ timeout: 30_000 });
  await expect(mom).toContainText(`${NAME.third} (2 of 3 votes)`);
  await expect(mom).toContainText(`Also received votes: ${NAME.opt} (1)`);
  await expect(mom).not.toContainText("Voting open");

  await page.goto("/");
  await expect(page.getByTestId("recent-result").filter({ hasText: `${NAME.third} (2 of 3 votes)` })).toHaveCount(1);
  await page.goto("/matches");
  await page.getByRole("button", { name: /^Past \(/ }).click();
  await expect(page.getByTestId("past-result").filter({ hasText: `${NAME.third} (2 of 3 votes)` })).toHaveCount(1);

  await signInAs(page, U.third, "/");
  await expect(page.getByTestId("dashboard-mom-wins")).toHaveText("1", { timeout: 30_000 });
  await page.goto("/profile/stats");
  await page.waitForURL("**/profile/stats", { timeout: 30_000 });
  const tile = page.locator("div.rounded-2xl").filter({ has: page.getByText("Man of the Match", { exact: true }) }).first();
  await expect(tile.locator("div").first()).toHaveText("1");

  await signInAs(page, U.admin, "/admin/stats");
  await expect(page.getByTestId("admin-stat-player").filter({ hasText: NAME.third }).getByTestId("admin-stat-mom")).toHaveText("1 MoM win");
  await expect(page.getByTestId("admin-stat-player").filter({ hasText: NAME.opt }).getByTestId("admin-stat-mom")).toHaveText("0 MoM wins");
});
