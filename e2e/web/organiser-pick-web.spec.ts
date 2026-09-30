/**
 * Organiser pick on the web (slice 2b, 2026-10-01, plan 2.13 and 5):
 *
 *   - /admin/settings "Who fills an open place" persists, and the
 *     "If nobody picks in time" row shows only for "The organisers pick";
 *   - the match page of an organiser-pick club shows admins the waiting
 *     list with position and rating, reorders it (BENCH positions only),
 *     and brings a player in through the same writer as a reply.
 *
 * The fixture club's upcoming match: 4/5 confirmed, Ben Bench waiting.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("settings: who fills an open place persists; the fallback row follows it", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  const mode = page.getByTestId("wr-pick-mode");
  await expect(mode).toHaveValue("first-come", { timeout: 30_000 });
  await expect(page.getByTestId("wr-fallback")).toHaveCount(0);
  await mode.selectOption("organiser");
  await expect
    .poll(async () => (await db.one<{ v: string }>(`SELECT "benchPickMode" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v)
    .toBe("organiser");
  const fallback = page.getByTestId("wr-fallback-mode");
  await expect(fallback).toHaveValue("bench-offer");
  await fallback.selectOption("leave-empty");
  await expect
    .poll(async () => (await db.one<{ v: string }>(`SELECT "benchPickFallback" AS v FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.v)
    .toBe("leave-empty");
  await page.reload();
  await expect(page.getByTestId("wr-pick-mode")).toHaveValue("organiser", { timeout: 30_000 });
  await expect(page.getByTestId("wr-fallback-mode")).toHaveValue("leave-empty");
});

test("match page: the waiting list reorders and brings a player in", async ({ page, db }) => {
  // A second waiting player, and an open place.
  await db.run(
    `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ('e2e-op-web-att', $1, $2, 'BENCH', 6, now())`,
    [MATCH.upcoming, U.extra],
  );
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  const list = page.getByTestId("waiting-list");
  await expect(list).toBeVisible({ timeout: 30_000 });
  const rows = list.getByTestId("waiting-list-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Ben Bench");
  await expect(rows.nth(1)).toContainText("Zara Zest");

  await page.getByRole("button", { name: "Move up: Zara Zest" }).click();
  await expect
    .poll(async () =>
      (
        await db.all<{ userId: string }>(
          `SELECT "userId" FROM "Attendance" WHERE "matchId" = $1 AND status = 'BENCH' ORDER BY position`,
          [MATCH.upcoming],
        )
      ).map((r) => r.userId),
    )
    .toEqual([U.extra, U.bench]);

  await page.reload();
  await expect(page.getByTestId("waiting-list-row").nth(0)).toContainText("Zara Zest", { timeout: 30_000 });
  await page.getByTestId("waiting-list-bring-in").first().click();
  await expect
    .poll(async () => (await db.one<{ status: string }>(`SELECT status::text AS status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.extra]))?.status)
    .toBe("CONFIRMED");
  const ev = await db.one<{ cause: string; actorUserId: string }>(
    `SELECT cause, "actorUserId" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 AND "toStatus" = 'CONFIRMED' ORDER BY at DESC LIMIT 1`,
    [MATCH.upcoming, U.extra],
  );
  expect(ev).toEqual({ cause: "organiser-pick", actorUserId: U.admin });
  // A2 in the community group.
  // Queued just after the write commits, so poll for it.
  await expect
    .poll(async () => (await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [ORG_ID])).map((p) => p.text))
    .toContain("✅ *Zara Zest* is in. Squad *5/5*.");
});
