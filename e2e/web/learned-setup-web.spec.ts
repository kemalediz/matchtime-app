/**
 * F3, learned setup on /admin/settings (2026-10-05): the panel that shows
 * what MatchTime set up from the group chat, highlighted from the DM's
 * link, with a one-tap Undo that puts the setting back and records it as
 * the organiser's own choice. A club that was never read shows no panel.
 *
 * 2026-10-12: what the chat shows and MatchTime changed nowhere is an
 * amber "N things to check" block ABOVE the switched settings, one card
 * per suggestion, each with a button that goes where the DM's link for
 * that kind goes. Before, they were a grey bullet list under the cards,
 * and only "organisers pick" had a link. With no suggestion the panel is
 * as it was.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";

/** Not committed (/test-results/ is gitignored): the finished panel, for review. */
const SHOTS = path.join(process.cwd(), "test-results", "learned-setup");

/** Nothing on the page, and nothing in the panel, is wider than its box. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const wide = await page.evaluate(() => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`page ${doc.scrollWidth} > ${doc.clientWidth}`);
    const panel = document.querySelector('[data-testid="learned-setup"]');
    const right = panel ? panel.getBoundingClientRect().right : 0;
    for (const el of panel ? Array.from(panel.querySelectorAll("*")) : []) {
      if (el.getBoundingClientRect().right > right + 0.5) out.push(`${el.tagName} ${el.getAttribute("data-testid") ?? ""}`);
    }
    return out;
  });
  expect(wide).toEqual([]);
}

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
      JSON.stringify([
        { key: "weeklyGameTime", current: "19:00", detected: "20:00", evidence: [] },
        {
          key: "organiserPicks",
          current: "first-come",
          detected: "organiser",
          evidence: ["Drop me a message and I'll sort the team", "I'll pick someone off the reserve list"],
        },
      ]),
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
  // What the chat shows and MatchTime changed nowhere: a labelled amber
  // block that says how many there are, above the switched settings.
  const check = page.getByRole("region", { name: "2 things to check" });
  await expect(check).toBeVisible();
  await expect(check).toHaveAttribute("data-testid", "learned-suggestions");
  await expect(check.getByRole("heading", { name: "2 things to check" })).toBeVisible();
  await expect(check).toContainText(
    "MatchTime changed nothing for these. Have a look, and change them yourself if the chat is right.",
  );
  await expect(check.getByRole("listitem")).toHaveCount(2);
  const checkBox = (await check.boundingBox())!;
  const itemBox = (await item.boundingBox())!;
  expect(checkBox.y + checkBox.height).toBeLessThanOrEqual(itemBox.y);
  // The deep-linked card's highlight is a ring; the block has none.
  await expect(check).not.toHaveClass(/ring-2/);

  // The kickoff time had no link on the page: now a button to where it is changed.
  const kickoff = page.getByTestId("learned-suggestion-weeklyGameTime");
  await expect(kickoff).toContainText("The chat says kickoff is at 20:00; your weekly game is set for 19:00.");
  await expect(kickoff.getByRole("link", { name: "Change kickoff time" })).toHaveAttribute("href", "/admin/activities");
  await expect(page.getByTestId("learned-noted")).toContainText(
    "Monthly list: regulars sign up and pay for the month and others pay as they go to fill spaces.",
  );
  // Monthly squad is a setting now, so the heading no longer says there is none.
  await expect(page.getByTestId("learned-noted").getByRole("heading")).toHaveText("Noticed, left for you to decide");

  // Who fills an open place is never switched from the chat: it is asked,
  // with the messages behind it and a way straight to the setting.
  const pick = page.getByTestId("learned-suggestion-organiserPicks");
  await expect(pick).toContainText(
    'It looks like the organisers choose who fills an open place. If that\'s right, switch on "The organisers pick".',
  );
  await expect(pick).toContainText(
    'From messages like: "Drop me a message and I\'ll sort the team", "I\'ll pick someone off the reserve list"',
  );
  await expect(page.getByTestId("learned-item-organiserPicks")).toHaveCount(0);
  await expect(page.getByTestId("wr-pick-mode")).toHaveValue("first-come");
  await expect(page.getByRole("link", { name: "Go to the setting" })).toHaveCount(0);
  await pick.getByRole("link", { name: 'Switch on "The organisers pick"' }).click();
  await expect(page.getByTestId("wr-pick")).toBeInViewport();

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

test("no suggestion: no check block, and the panel is as it was", async ({ page, db }) => {
  await db.run(`UPDATE "ClubSetupLearning" SET suggestions = '[]'::jsonb WHERE "orgId" = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/settings#learned-setup");
  const panel = page.getByTestId("learned-setup");
  await expect(panel.getByTestId("learned-item-rollingSquad")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("learned-suggestions")).toHaveCount(0);
  await expect(panel.getByRole("region")).toHaveCount(0);
  await expect(panel).not.toContainText("to check");
  // The lead, the switched settings, then what was noticed: nothing else.
  await expect(panel.locator("> div").nth(1).locator("> *")).toHaveCount(3);
  await expect(panel.getByTestId("learned-noted")).toBeVisible();
});

test("two things to check over four switched settings: every one has a working button, on a phone too", async ({ page, db }) => {
  await db.run(
    `UPDATE "Organisation" SET "rollingSquadEnabled" = true, "paymentTrackingEnabled" = true,
       "dropOutDeadlineDay" = 1, "dropOutDeadlineTime" = '21:00', "listPublishDay" = 2, "listPublishTime" = '20:00'
     WHERE id = $1`,
    [ORG_ID],
  );
  await db.run(`UPDATE "ClubSetupLearning" SET applied = $2::jsonb, suggestions = $3::jsonb, noted = '[]'::jsonb WHERE "orgId" = $1`, [
    ORG_ID,
    JSON.stringify([
      { key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week", "same squad again"], undoneAt: null },
      { key: "dropOutDeadline", from: null, to: { day: 1, time: "21:00" }, evidence: ["Drop out by Monday 9pm"], undoneAt: null },
      { key: "listPublish", from: null, to: { day: 2, time: "20:00" }, evidence: ["Final list goes up Tuesday at 8pm"], undoneAt: null },
      { key: "paymentTracking", from: false, to: true, evidence: ["sent £6", "paid"], undoneAt: null },
    ]),
    JSON.stringify([
      { key: "weeklyGameTime", current: "20:00", detected: "20:30", evidence: ["8.30 kick off as usual"] },
      {
        key: "organiserPicks",
        current: "first-come",
        detected: "organiser",
        evidence: ["Drop me a message and I'll sort the team", "I'll pick someone off the reserve list"],
      },
    ]),
  ]);

  await signInAs(page, U.admin, "/admin/settings#learned-setup");
  const panel = page.getByTestId("learned-setup");
  const check = page.getByRole("region", { name: "2 things to check" });
  await expect(check).toBeVisible({ timeout: 30_000 });
  const applied = ["rollingSquad", "dropOutDeadline", "listPublish", "paymentTracking"];
  for (const key of applied) await expect(page.getByTestId(`learned-item-${key}`)).toHaveAttribute("data-state", "active");

  // Each suggestion is its own card: its line, the messages behind it, its button.
  const kickoff = page.getByTestId("learned-suggestion-weeklyGameTime");
  await expect(kickoff).toContainText("The chat says kickoff is at 20:30; your weekly game is set for 20:00.");
  await expect(kickoff).toContainText('From messages like: "8.30 kick off as usual"');
  const pick = page.getByTestId("learned-suggestion-organiserPicks");
  const actions = check.getByRole("link");
  await expect(actions).toHaveCount(2);
  await expect(actions.nth(0)).toHaveAccessibleName("Change kickoff time");
  await expect(actions.nth(1)).toHaveAccessibleName('Switch on "The organisers pick"');
  await expect(pick.getByRole("link")).toHaveAttribute("href", "#wr-pick");
  // The icon is decoration: the words carry the warning.
  await expect(check.locator("svg").first()).toHaveAttribute("aria-hidden", "true");

  // Above every switched setting.
  const bottom = await check.boundingBox().then((b) => b!.y + b!.height);
  for (const key of applied) {
    expect((await page.getByTestId(`learned-item-${key}`).boundingBox())!.y).toBeGreaterThanOrEqual(bottom);
  }
  // On a desktop the button sits on the right, where Undo sits on a switched setting.
  const actionBox = (await kickoff.getByRole("link").boundingBox())!;
  const undoBox = (await page.getByTestId("learned-undo-rollingSquad").boundingBox())!;
  const lineBox = (await kickoff.getByTestId("learned-suggestion-line").boundingBox())!;
  expect(actionBox.x).toBeGreaterThan(lineBox.x + lineBox.width - 1);
  expect(Math.abs(actionBox.x + actionBox.width - (undoBox.x + undoBox.width))).toBeLessThan(40);
  await expectNoHorizontalOverflow(page);

  mkdirSync(SHOTS, { recursive: true });
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(SHOTS, "learned-setup-desktop.png") });

  // A phone, which is where the organiser opens this from WhatsApp: the
  // button wraps under the words and nothing scrolls sideways.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(check).toBeVisible();
  for (const card of [kickoff, pick]) {
    const line = (await card.getByTestId("learned-suggestion-line").boundingBox())!;
    const action = (await card.getByRole("link").boundingBox())!;
    expect(action.y).toBeGreaterThanOrEqual(line.y + line.height - 1);
  }
  await expectNoHorizontalOverflow(page);
  await panel.screenshot({ path: path.join(SHOTS, "learned-setup-phone.png") });

  // The kickoff button goes where the DM's "Change it here" link goes.
  await page.setViewportSize({ width: 1280, height: 720 });
  await kickoff.getByRole("link", { name: "Change kickoff time" }).click();
  await expect(page).toHaveURL(/\/admin\/activities$/, { timeout: 30_000 });
});
