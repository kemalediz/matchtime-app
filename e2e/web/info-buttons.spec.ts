/**
 * F1 (2026-10-05): the organiser ⓘ buttons.
 *
 * Every organiser page carries an ⓘ per section, badge or field; tapping
 * one opens a popup that explains it in the club's language. For each
 * page this spec checks the buttons are there and that one popup opens,
 * shows its title, and closes. The dashboard tile check also proves an ⓘ
 * beside a tile's link opens the popup instead of navigating.
 *
 * The billing page's ⓘ are checked in billing.spec.ts, which owns that
 * page's fixture world.
 */
import type { Page } from "@playwright/test";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID, MATCH } from "../helpers/constants";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const SESSION_ID = "e2e-onb-info";

test.beforeAll(async () => {
  resetDb();
  await testDb().run(
    `INSERT INTO "OnboardingSession"
       (id, "whatsappGroupId", "orgId", stage, source, "selectedFeatures",
        "enrichmentStatus", "proposedRoster", "unresolvedMembers",
        "capturedSchedule", "createdAt", "updatedAt")
     VALUES ($1,'e2e-info-group',$2,'completed','group-add','{}','ready',
             $3::jsonb,$4::jsonb,'{}'::jsonb, now(), now())`,
    [
      SESSION_ID,
      ORG_ID,
      JSON.stringify([
        {
          name: "Pat Player",
          matchedUserId: U.player,
          proposedPosition: "MID",
          proposedSeedRating: 6,
          evidence: "No clear signal in chat — defaulting to neutral",
          confidence: 0,
        },
      ]),
      JSON.stringify([{ name: "Gary Guest", userId: U.guest }]),
    ],
  );
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

/** Each ⓘ is on the page; then `open` opens, shows `title`, and closes. */
async function expectInfos(page: Page, keys: string[], open: string, title: string | RegExp) {
  for (const k of keys) {
    await expect(page.getByTestId(`info-${k}`).first(), k).toBeVisible({ timeout: 30_000 });
  }
  await page.getByTestId(`info-${open}`).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: title })).toBeVisible();
  await sheet.getByRole("button", { name: /^(Close|Kapat)$/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("/finish-setup: every section and field, and the guess wording", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, `/finish-setup/${SESSION_ID}`);
  await expectInfos(
    page,
    ["fs_players", "fs_confidence", "fs_position", "fs_seed", "fs_evidence", "fs_phones", "fs_schedule"],
    "fs_confidence",
    "How sure MatchTime is",
  );
  await expect(page.getByTestId("confidence-badge")).toHaveText("Guess: please check");
  await expect(page.getByTestId("evidence")).toHaveText(
    "Nothing in the chat about this player, so I've set a neutral starting point.",
  );
  await expect(page.getByText("No clear signal")).toHaveCount(0);
});

test("/admin dashboard: every card, and a tile's ⓘ does not navigate", async ({ page }) => {
  await signInAs(page, U.admin, "/admin");
  await page.waitForURL("**/admin");
  await expectInfos(
    page,
    ["dash_players", "dash_activities", "dash_upcoming", "dash_completed", "dash_ratings"],
    "dash_players",
    "Players",
  );
  expect(new URL(page.url()).pathname).toBe("/admin");
});

test("/admin/players: list, add, columns, aliases, merge, new players", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/players");
  await page.waitForURL("**/admin/players");
  await page.getByRole("button", { name: "Add player" }).click({ timeout: 30_000 });
  await expectInfos(
    page,
    ["pl_list", "pl_add", "pl_seed", "pl_club_rating", "pl_aliases", "pl_merge", "pl_role", "pl_new"],
    "pl_seed",
    "Seed rating",
  );
});

test("/admin/settings: every section and every feature switch (EN and TR)", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  await expectInfos(
    page,
    [
      "st_general",
      "st_team_names",
      "st_language",
      "st_invite",
      "st_features",
      "feat_attendance",
      "feat_bench",
      "feat_teams",
      "feat_mom",
      "feat_rating",
      "feat_reminders",
      "feat_stats",
      "feat_pay_tracking",
      "feat_pay_collect",
      "feat_pay_bank",
      "feat_pay_card",
      "feat_pay_direct",
      "feat_badges",
      "st_weekly",
      "st_collector",
      "st_bank",
      "st_whatsapp",
    ],
    "feat_attendance",
    "Attendance tracking",
  );
  // The Friday features keep their own ⓘ.
  const weekly = page.getByTestId("weekly-routine");
  for (const name of ["What is Rolling squad?", "What is Drop-out deadline?", "What is List published?", "What is Admin messages go to?"]) {
    await expect(weekly.getByRole("button", { name })).toBeVisible();
  }

  // A Turkish club reads the popups in Turkish.
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  await page.getByRole("button", { name: "Katılım takibi nedir?" }).click({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toContainText("VARIM ve YOKUM");
  await page.getByRole("button", { name: "Kapat" }).click();
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("/admin/activities: the page, active state, generate and the sign-up cut-off", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/activities");
  await page.waitForURL("**/admin/activities");
  await expectInfos(page, ["act_page", "act_active", "act_generate", "act_deadline"], "act_deadline", "Sign-ups close");
});

test("/admin/block-bookings and bulk cancel / restore", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/block-bookings");
  await page.waitForURL("**/admin/block-bookings");
  await expectInfos(page, ["bb_page"], "bb_page", "Block bookings");
  await page.goto("/admin/matches/bulk");
  await expectInfos(page, ["bulk_page"], "bulk_page", "Bulk cancel or restore");
});

test("/admin/matches: teams (with teams and score), switch format and cancel", async ({ page }) => {
  await signInAs(page, U.admin, `/admin/matches/${MATCH.rate}/teams`);
  await page.waitForURL(`**/admin/matches/${MATCH.rate}/teams`);
  await expectInfos(page, ["teams_page", "switch", "teams_score"], "teams_score", "Match score");

  await page.goto(`/admin/matches/${MATCH.upcoming}/teams`);
  await expectInfos(page, ["teams_page", "switch", "cancel"], "teams_page", "Team management");

  await page.goto(`/admin/matches/${MATCH.upcoming}/switch-format`);
  await expectInfos(page, ["switch"], "switch", "Switch format");

  await page.goto(`/admin/matches/${MATCH.upcoming}/cancel`);
  await expectInfos(page, ["cancel"], "cancel", "Cancel match");
});

test("/admin/clubs and /admin/health (owner only)", async ({ page, db }) => {
  await db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = $1`, [U.admin]);
  await signInAs(page, U.admin, "/admin/clubs");
  await page.waitForURL("**/admin/clubs");
  await expectInfos(
    page,
    ["clubs_waiting", "clubs_live", "clubs_unsolicited", "clubs_rejected", "clubs_suspended", "clubs_limits"],
    "clubs_waiting",
    "Waiting for you",
  );
  await page.goto("/admin/health");
  await expectInfos(page, ["health_status", "health_alerts"], "health_alerts", "Recent alerts");
  await db.run(`UPDATE "User" SET "isSuperadmin" = false WHERE id = $1`, [U.admin]);
});
