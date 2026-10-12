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
import type { Page, Request } from "@playwright/test";
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

type Box = { top: number; bottom: number; left: number; right: number };

/**
 * Where several elements are, ALL READ IN THE SAME FRAME.
 *
 * Every position on a page is measured from the top of the window, and
 * this page is moving when the test first looks at it: the panel scrolls
 * itself into view (the `#learned-setup` link), and `<html>` has
 * `scroll-behavior: smooth`, so that scroll is an animation of about
 * 275px over about 270ms. Two `locator.boundingBox()` calls are two
 * round trips a few milliseconds apart. Mid-animation the page travels up
 * to 62px between them, which is more than the 52px that separates the
 * "things to check" block from the first switched setting, so the second
 * element was read as sitting 5 to 10px inside the first one about two
 * runs in ten. Nothing overlapped: the two readings were of two different
 * scroll positions. Read together, the scroll cancels out.
 */
async function boxesOf<K extends string>(page: Page, selectors: Record<K, string>): Promise<Record<K, Box>> {
  return page.evaluate((sel) => {
    const out: Record<string, Box> = {};
    for (const [name, css] of Object.entries(sel as Record<string, string>)) {
      const el = document.querySelector(css);
      if (!el) throw new Error(`boxesOf: nothing matches ${css}`);
      const r = el.getBoundingClientRect();
      out[name] = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }
    return out;
  }, selectors) as Promise<Record<K, Box>>;
}

const tid = (id: string): string => `[data-testid="${id}"]`;

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
        // The seeded weekly game kicks off at 20:00, which is what the reading saw.
        { key: "weeklyGameTime", current: "20:00", detected: "21:00", evidence: [] },
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
  const at = await boxesOf(page, { check: tid("learned-suggestions"), item: tid("learned-item-rollingSquad") });
  expect(at.check.bottom).toBeLessThanOrEqual(at.item.top);
  // The deep-linked card's highlight is a ring; the block has none.
  await expect(check).not.toHaveClass(/ring-2/);

  // The kickoff time had no link on the page: now a button to where it is changed.
  const kickoff = page.getByTestId("learned-suggestion-weeklyGameTime");
  await expect(kickoff).toContainText("The chat says kickoff is at 21:00; your weekly game is set for 20:00.");
  await expect(kickoff.getByRole("link", { name: "Change kickoff time" })).toHaveAttribute("href", "/admin/activities");
  // Both still stand, so nothing is listed as sorted.
  await expect(page.getByTestId("learned-resolved")).toHaveCount(0);
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
  const lineOf = (key: string): string => `${tid(`learned-suggestion-${key}`)} ${tid("learned-suggestion-line")}`;
  const wide = await boxesOf(page, {
    check: tid("learned-suggestions"),
    rollingSquad: tid("learned-item-rollingSquad"),
    dropOutDeadline: tid("learned-item-dropOutDeadline"),
    listPublish: tid("learned-item-listPublish"),
    paymentTracking: tid("learned-item-paymentTracking"),
    action: tid("learned-action-weeklyGameTime"),
    undo: tid("learned-undo-rollingSquad"),
    line: lineOf("weeklyGameTime"),
  });
  for (const key of ["rollingSquad", "dropOutDeadline", "listPublish", "paymentTracking"] as const) {
    expect(wide[key].top).toBeGreaterThanOrEqual(wide.check.bottom);
  }
  // On a desktop the button sits on the right, where Undo sits on a switched setting.
  expect(wide.action.left).toBeGreaterThan(wide.line.right - 1);
  expect(Math.abs(wide.action.right - wide.undo.right)).toBeLessThan(40);
  await expectNoHorizontalOverflow(page);

  mkdirSync(SHOTS, { recursive: true });
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(SHOTS, "learned-setup-desktop.png") });

  // A phone, which is where the organiser opens this from WhatsApp: the
  // button wraps under the words and nothing scrolls sideways.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(check).toBeVisible();
  await expect(pick).toBeVisible();
  for (const key of ["weeklyGameTime", "organiserPicks"]) {
    const narrow = await boxesOf(page, { line: lineOf(key), action: tid(`learned-action-${key}`) });
    expect(narrow.action.top).toBeGreaterThanOrEqual(narrow.line.bottom - 1);
  }
  await expectNoHorizontalOverflow(page);
  await panel.screenshot({ path: path.join(SHOTS, "learned-setup-phone.png") });

  // The kickoff button goes where the DM's "Change it here" link goes.
  await page.setViewportSize({ width: 1280, height: 720 });
  await kickoff.getByRole("link", { name: "Change kickoff time" }).click();
  await expect(page).toHaveURL(/\/admin\/activities$/, { timeout: 30_000 });
});

/**
 * The owner's case (2026-10-12). He pressed "Change kickoff time", moved
 * the weekly game from 20:00 to 20:30, came back, and the card still said
 * "your weekly game is set for 20:00", with the same button. The stored
 * suggestions are a snapshot; the page now holds each against what the
 * club has today. This test starts from the club the test above left:
 * kickoff 20:00 with the chat saying 20:30, and "organisers pick" asked.
 */
test("a suggestion the organiser has dealt with leaves the block, and a quiet line says what the club has now", async ({ page, db }) => {
  const isAction = (r: Request) => r.method() === "POST" && r.headers()["next-action"] !== undefined;
  const stored = () =>
    db.one<{ suggestions: Array<{ key: string; current: string; detected: string }> }>(
      `SELECT suggestions FROM "ClubSetupLearning" WHERE "orgId" = $1`,
      [ORG_ID],
    );
  const before = await stored();

  await signInAs(page, U.admin, "/admin/settings#learned-setup");
  const panel = page.getByTestId("learned-setup");
  await expect(page.getByRole("region", { name: "2 things to check" })).toBeVisible({ timeout: 30_000 });
  const kickoff = page.getByTestId("learned-suggestion-weeklyGameTime");
  const pick = page.getByTestId("learned-suggestion-organiserPicks");
  const kickoffDone = page.getByTestId("learned-resolved-weeklyGameTime");
  const pickDone = page.getByTestId("learned-resolved-organiserPicks");

  // The first amber button, the weekly game page, 20:00 to 20:30, and back.
  await kickoff.getByRole("link", { name: "Change kickoff time" }).click();
  await expect(page).toHaveURL(/\/admin\/activities$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('form input[type="time"]').fill("20:30");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Tuesdays at 20:30")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/settings#learned-setup$/, { timeout: 30_000 });

  // No reload: the heading counts what is still open, the kickoff card is
  // gone, and one small line with no button says what the club has now.
  const check = page.getByRole("region", { name: "1 thing to check" });
  await expect(check).toBeVisible({ timeout: 30_000 });
  await expect(check.getByRole("listitem")).toHaveCount(1);
  await expect(kickoff).toHaveCount(0);
  await expect(pick).toBeVisible();
  await expect(kickoffDone).toHaveText("Kickoff time is now 20:30.");
  await expect(kickoffDone.locator("svg")).toHaveAttribute("aria-hidden", "true");
  const sorted = panel.getByRole("list", { name: "Already sorted" });
  await expect(sorted.getByRole("listitem")).toHaveCount(1);
  await expect(sorted.getByRole("link")).toHaveCount(0);
  await expect(sorted.getByRole("button")).toHaveCount(0);
  await expect(panel).not.toContainText("your weekly game is set for 20:00");
  // Under the amber block, over the switched settings, and small.
  const at = await boxesOf(page, {
    check: tid("learned-suggestions"),
    done: tid("learned-resolved-weeklyGameTime"),
    card: tid("learned-suggestion-organiserPicks"),
    item: tid("learned-item-rollingSquad"),
  });
  expect(at.done.top).toBeGreaterThanOrEqual(at.check.bottom);
  expect(at.done.bottom).toBeLessThanOrEqual(at.item.top);
  expect(at.done.bottom - at.done.top).toBeLessThan((at.card.bottom - at.card.top) / 2);
  await expectNoHorizontalOverflow(page);
  // The row is the snapshot it always was: nothing was written to it.
  expect(await stored()).toEqual(before);

  mkdirSync(SHOTS, { recursive: true });
  await expect(page.getByText("Activity updated")).toHaveCount(0); // the toast, out of the picture
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(SHOTS, "learned-resolved-desktop.png") });
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(kickoffDone).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(SHOTS, "learned-resolved-phone.png") });
  await page.setViewportSize({ width: 1280, height: 720 });

  // The other one is a setting on this page: saved there, it leaves the
  // block too, and with nothing open there is no amber block at all.
  await pick.getByRole("link", { name: 'Switch on "The organisers pick"' }).click();
  await page.getByTestId("wr-pick-mode").selectOption("organiser");
  await expect(page.getByTestId("learned-suggestions")).toHaveCount(0);
  await expect(panel.getByRole("region")).toHaveCount(0);
  await expect(panel).not.toContainText("to check");
  await expect(pickDone).toHaveText('"The organisers pick" is on.');
  await expect(sorted.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("learned-item-rollingSquad")).toBeVisible();
  // Saving it did not pull the page back up to the panel.
  await expect(page.getByTestId("wr-pick")).toBeInViewport();
  expect(await stored()).toEqual(before);

  // The state is worked out, not stored: put the kickoff back and the card
  // returns. The page learns of it when it is restored from the browser's
  // back-forward cache, in ONE request, and does not keep asking.
  await db.run(`UPDATE "Activity" SET time = '20:00' WHERE "orgId" = $1`, [ORG_ID]);
  const loads: string[] = [];
  page.on("request", (r) => {
    if (isAction(r)) loads.push(r.url());
  });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("region", { name: "1 thing to check" })).toBeVisible();
  await expect(kickoff).toContainText("The chat says kickoff is at 20:30; your weekly game is set for 20:00.");
  await expect(kickoffDone).toHaveCount(0);
  // A page shown for the first time (not restored) asks for nothing.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
  // A third value: the organiser looked and chose 19:00. Resolved, at that value.
  await db.run(`UPDATE "Activity" SET time = '19:00' WHERE "orgId" = $1`, [ORG_ID]);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(kickoffDone).toHaveText("Kickoff time is now 19:00.");
  await expect(page.getByTestId("learned-suggestions")).toHaveCount(0);
  expect(loads).toHaveLength(2);

  // The DM is a snapshot and still links to the suggestion: the link
  // lands on its line, highlighted, in the club's language.
  await db.run(`UPDATE "Activity" SET time = '20:30' WHERE "orgId" = $1`, [ORG_ID]);
  await page.goto("/admin/settings?learned=weeklyGameTime#learned-setup");
  await expect(kickoffDone).toHaveText("Kickoff time is now 20:30.", { timeout: 30_000 });
  await expect(kickoffDone).toHaveClass(/ring-2/);
  await expect(kickoffDone).toBeInViewport();
  await expect(pickDone).not.toHaveClass(/ring-2/);

  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  await expect(kickoffDone).toHaveText("Maç saati artık 20:30.", { timeout: 30_000 });
  await expect(pickDone).toHaveText('"Organizatörler seçer" ayarı açık.');
  await expect(panel.getByRole("list", { name: "Halledilenler" }).getByRole("listitem")).toHaveCount(2);
});
