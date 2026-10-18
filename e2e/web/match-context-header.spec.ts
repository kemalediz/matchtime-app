/**
 * The match context header (Kemal, 2026-10-18).
 *
 * "Payments · who's paid" on a played match opens /collect/<match>,
 * which named only the game: no day, no kickoff, no venue, so the
 * organiser lost track of which match it was. The page stays a page
 * (one row per player is long), but now says which match it is and
 * links back. The team management page gets the same header.
 *
 *   - payments page: day, kickoff, venue, status and Back to match,
 *     which returns to the match page; the roster is still there;
 *   - the collector (not an admin) sees the same header;
 *   - the team management page shows the same header, with the score
 *     once there is one, and keeps its own "Team management" heading;
 *   - both fit 390px with no horizontal scroll.
 *
 * Deterministic: nothing here calls a model.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, NAME } from "../helpers/constants";
import { dayLabel, timeLabel } from "@/lib/i18n/dates";

test.describe.configure({ mode: "serial" });

/** Not committed (/test-results/ is gitignored): the finished pages, for review. */
const SHOTS = path.join(process.cwd(), "test-results", "match-context");

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function kickoffOf(db: import("../helpers/test-db").TestDb, id: string): Promise<Date> {
  // The column is a UTC timestamp without a zone: read it as text, or the
  // driver takes it for local time and the kickoff is an hour out in BST.
  const row = await db.one<{ iso: string }>(
    `SELECT to_char(date, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso FROM "Match" WHERE id = $1`,
    [id],
  );
  return new Date(row!.iso);
}

test("payments page: day, kickoff, venue and status, and Back to match returns to the match", async ({ page, db }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, `/collect/${MATCH.pay}`);
  await page.waitForURL(`**/collect/${MATCH.pay}`);
  const kickoff = await kickoffOf(db, MATCH.pay);

  const header = page.getByTestId("match-context-header");
  await expect(header).toBeVisible();
  await expect(header.getByRole("heading", { level: 1 })).toHaveText("E2E 5-a-side");
  await expect(header.getByTestId("match-context-sport")).toHaveText("Football 5-a-side");
  await expect(header.getByTestId("match-context-date")).toHaveText(dayLabel("en", kickoff));
  await expect(header.getByTestId("match-context-time")).toHaveText(`Kickoff ${timeLabel(kickoff)}`);
  await expect(header.getByTestId("match-context-venue")).toHaveText("E2E Arena");
  await expect(header.getByTestId("match-context-status")).toHaveText("Played");
  await expect(header.getByText("E2E Test FC")).toBeVisible();
  // No score on the PAY match yet: no score line.
  await expect(header.getByTestId("match-context-score")).toHaveCount(0);

  // Everything else on the page is still there.
  await expect(page.getByText(/Fee £8 per player/)).toBeVisible();
  await expect(page.getByTestId(`collect-row-${U.player}`)).toBeVisible();

  await noHorizontalScroll(page);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, "payments-header-390.png"), fullPage: true });

  const back = header.getByTestId("match-context-back");
  await expect(back).toHaveText("Back to match");
  await expect(back).toHaveAttribute("href", `/matches/${MATCH.pay}`);
  await back.click();
  await page.waitForURL(`**/matches/${MATCH.pay}`);
  await expect(page.getByTestId("payments-link")).toBeVisible();
});

test("the money collector (not an admin) sees the same header", async ({ page, db }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.collector, `/collect/${MATCH.pay}`);
  await page.waitForURL(`**/collect/${MATCH.pay}`);
  const kickoff = await kickoffOf(db, MATCH.pay);
  const header = page.getByTestId("match-context-header");
  await expect(header.getByTestId("match-context-date")).toHaveText(dayLabel("en", kickoff));
  await expect(header.getByTestId("match-context-venue")).toHaveText("E2E Arena");
  await expect(header.getByTestId("match-context-back")).toHaveAttribute("href", `/matches/${MATCH.pay}`);
  // The collector is still left off the list they collect for.
  await expect(page.getByRole("main").getByText(NAME.collector)).toHaveCount(0);
  await noHorizontalScroll(page);
});

test("a player who is neither collector nor admin still gets no payments page", async ({ page }) => {
  await signInAs(page, U.player, `/collect/${MATCH.pay}`);
  await page.waitForURL((u) => !u.pathname.startsWith("/collect"));
  await expect(page.getByTestId("match-context-header")).toHaveCount(0);
});

test("team management page: the same header, with the score, and its own heading kept", async ({ page, db }) => {
  await db.run(`UPDATE "Match" SET "redScore" = 4, "yellowScore" = 1 WHERE id = $1`, [MATCH.pay]);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, `/admin/matches/${MATCH.pay}/teams`);
  const kickoff = await kickoffOf(db, MATCH.pay);

  const header = page.getByTestId("match-context-header");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(header.getByRole("heading", { level: 2 })).toHaveText("E2E 5-a-side");
  await expect(header.getByTestId("match-context-date")).toHaveText(dayLabel("en", kickoff));
  await expect(header.getByTestId("match-context-time")).toHaveText(`Kickoff ${timeLabel(kickoff)}`);
  await expect(header.getByTestId("match-context-venue")).toHaveText("E2E Arena");
  await expect(header.getByTestId("match-context-status")).toHaveText("Played");
  await expect(header.getByTestId("match-context-score")).toHaveText("Red 4 - 1 Yellow");
  await expect(page.getByRole("heading", { level: 1, name: /Team management/ })).toBeVisible();

  await noHorizontalScroll(page);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, "teams-header-390.png"), fullPage: true });

  await header.getByTestId("match-context-back").click();
  await page.waitForURL(`**/matches/${MATCH.pay}`);
});

test("team management page of a match still to come: no score, Upcoming", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, `/admin/matches/${MATCH.upcoming}/teams`);
  const header = page.getByTestId("match-context-header");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(header.getByTestId("match-context-status")).toHaveText("Upcoming");
  await expect(header.getByTestId("match-context-score")).toHaveCount(0);
  await expect(header.getByTestId("match-context-back")).toHaveAttribute("href", `/matches/${MATCH.upcoming}`);
  await noHorizontalScroll(page);
});
