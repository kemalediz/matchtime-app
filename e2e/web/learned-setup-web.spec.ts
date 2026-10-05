/**
 * F3, learned setup on /admin/settings (2026-10-05): the panel that shows
 * what MatchTime set up from the group chat, highlighted from the DM's
 * link, with a one-tap Undo that puts the setting back and records it as
 * the organiser's own choice. A club that was never read shows no panel.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("a club never read: no panel", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("learned-setup")).toHaveCount(0);
});

test("the DM's link highlights the item; Undo puts it back in one tap", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "rollingSquadEnabled" = true WHERE id = $1`, [ORG_ID]);
  await db.run(
    `INSERT INTO "ClubSetupLearning" (id, "orgId", status, applied, suggestions, noted, "updatedAt")
     VALUES ('e2e-learn-web', $1, 'applied', $2::jsonb, $3::jsonb, $4::jsonb, now())`,
    [
      ORG_ID,
      JSON.stringify([{ key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"], undoneAt: null }]),
      JSON.stringify([{ key: "weeklyGameTime", current: "19:00", detected: "20:00", evidence: [] }]),
      JSON.stringify([
        {
          key: "monthlyList",
          prepayForMonth: true,
          payAsYouGoFillIns: true,
          creditForMissedGames: false,
          confidence: "high",
          evidence: ["pay monthly"],
          heldPaymentTracking: false,
        },
      ]),
    ],
  );

  await signInAs(page, U.admin, "/admin/settings?learned=rollingSquad#learned-setup");
  const item = page.getByTestId("learned-item-rollingSquad");
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(item).toHaveAttribute("data-state", "active");
  await expect(item).toHaveClass(/ring-2/);
  await expect(item).toContainText("Rolling squad is on: whoever played last time is in next time, unless they say OUT.");
  await expect(item).toContainText('From messages like: "Same lot as last week"');
  await expect(page.getByTestId("learned-suggestions")).toContainText(
    "The chat says kickoff is at 20:00; your weekly game is set for 19:00.",
  );
  await expect(page.getByTestId("learned-noted")).toContainText(
    "Monthly list: regulars sign up and pay for the month and others pay as they go to fill spaces.",
  );

  await page.getByTestId("learned-undo-rollingSquad").click();
  await expect
    .poll(async () =>
      db.one<{ on: boolean; set: string[] }>(
        `SELECT "rollingSquadEnabled" AS on, "settingsSetByOrganiser" AS set FROM "Organisation" WHERE id = $1`,
        [ORG_ID],
      ),
    )
    .toEqual({ on: false, set: ["rollingSquad"] });
  await expect(page.getByTestId("learned-item-rollingSquad")).toHaveAttribute("data-state", "undone", { timeout: 30_000 });
  await expect(page.getByTestId("learned-undo-rollingSquad")).toHaveCount(0);
});
