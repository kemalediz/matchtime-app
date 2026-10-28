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
import { countRequestsOf } from "../helpers/action-requests";
import { ORG_ID } from "../helpers/constants";
import { openSettingsCard } from "../helpers/settings-nav";

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

/**
 * Arm BEFORE something that starts a smooth scroll; the returned function
 * waits until that scroll has really finished. The scroll is the
 * browser's own animation (about 850ms for the length of this page) and
 * no test clock speeds it up: a position read before it ends is a
 * position on the way, and a row "in the viewport" then may only be
 * passing through.
 */
async function scrollEnd(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const w = window as unknown as { __scrollEnded: boolean };
    w.__scrollEnded = false;
    window.addEventListener("scrollend", () => (w.__scrollEnded = true), { once: true });
  });
  return () => expect.poll(() => page.evaluate(() => (window as unknown as { __scrollEnded: boolean }).__scrollEnded)).toBe(true);
}

/** What a plain return to the tab does: both events fire, and the tab was never hidden. */
const comeBack = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });

/** The tab is hidden (another tab, another app), or shown again. */
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
    if (!h) window.dispatchEvent(new Event("focus"));
  }, hidden);

test.describe.configure({ mode: "serial" });

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("a club never read: no panel", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("settings-tabs")).toBeVisible({ timeout: 30_000 });
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
  // The panel's own loads, and no other feature's on the page.
  await page.clock.install();
  const loads = countRequestsOf(page, (body) => body.includes('"suggestions"') && body.includes('"applied"'));
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

  // WHEN THE PANEL LOADS AGAIN. Each load is a server action, and those
  // are sent one at a time, so it must not load on every return to the
  // tab. Counted from here; a load that should not have gone would show
  // in the exact counts below.
  await expect.poll(() => loads.known()).toBe(true);
  await page.waitForLoadState("networkidle");
  loads.reset();
  // A plain return to the tab, five times: nothing.
  for (let i = 0; i < 5; i++) await comeBack(page);
  // A glance away (hidden for one second): nothing.
  await setHidden(page, true);
  await page.clock.fastForward(1_000);
  await setHidden(page, false);
  // Away for six seconds (another page, or WhatsApp): one load.
  await setHidden(page, true);
  await page.clock.fastForward(6_000);
  await setHidden(page, false);
  await expect.poll(() => loads.count()).toBe(1);
  await page.waitForLoadState("networkidle");
  // Away again for four seconds, straight after: within five seconds of
  // the last load, so nothing.
  await setHidden(page, true);
  await page.clock.fastForward(4_000);
  await setHidden(page, false);

  // The other one is a setting on this page: saved there, the panel loads
  // at once. The organiser is down the page at that setting and STAYS
  // there, with the whole row on the screen: the panel, off the top of
  // the screen, does not change height under them (it used to, about two
  // runs in thirty: the card went while the page was still scrolling down
  // to the setting, and the scroll ended 156px past it).
  const scrolledDown = await scrollEnd(page);
  await pick.getByRole("link", { name: 'Switch on "The organisers pick"' }).click();
  await page.getByTestId("wr-pick-mode").selectOption("organiser");
  await expect.poll(() => loads.count()).toBe(2);
  await page.waitForLoadState("networkidle");
  await scrolledDown();
  await page.clock.runFor(2_000);
  await expect(page.getByTestId("wr-pick")).toBeInViewport({ ratio: 1 });
  // Back up at the panel, it shows what it loaded: it leaves the block
  // too, and with nothing open there is no amber block at all.
  await panel.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("learned-suggestions")).toHaveCount(0);
  expect(loads.count()).toBe(2);
  await expect(panel.getByRole("region")).toHaveCount(0);
  await expect(panel).not.toContainText("to check");
  await expect(pickDone).toHaveText('"The organisers pick" is on.');
  await expect(sorted.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("learned-item-rollingSquad")).toBeVisible();
  expect(await stored()).toEqual(before);

  // The state is worked out, not stored: put the kickoff back and the card
  // returns. The page learns of it when it is restored from the browser's
  // back-forward cache, in ONE request, at most once every five seconds.
  await db.run(`UPDATE "Activity" SET time = '20:00' WHERE "orgId" = $1`, [ORG_ID]);
  const restored = (persisted: boolean) =>
    page.evaluate((p) => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: p })), persisted);
  await page.clock.fastForward(6_000);
  await restored(true);
  await expect(page.getByRole("region", { name: "1 thing to check" })).toBeVisible();
  await expect(kickoff).toContainText("The chat says kickoff is at 20:30; your weekly game is set for 20:00.");
  await expect(kickoffDone).toHaveCount(0);
  expect(loads.count()).toBe(3);
  // Restored again straight away: nothing. Shown for the first time (not restored): nothing.
  await restored(true);
  await restored(false);
  // A third value: the organiser looked and chose 19:00. Resolved, at that value.
  await db.run(`UPDATE "Activity" SET time = '19:00' WHERE "orgId" = $1`, [ORG_ID]);
  await page.clock.fastForward(6_000);
  await restored(true);
  await expect(kickoffDone).toHaveText("Kickoff time is now 19:00.");
  await expect(page.getByTestId("learned-suggestions")).toHaveCount(0);
  expect(loads.count()).toBe(4);

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

/**
 * A RELOAD OF THE PANEL NEVER MOVES THE PAGE (2026-10-12).
 *
 * What went wrong: the organiser taps 'Switch on "The organisers pick"',
 * the page begins its smooth scroll down to that setting (about 2,900px,
 * 850ms), they save it, the panel reloads and its card (180px) is removed
 * while the scroll is still running, and the scroll ends where the
 * setting USED to be. The row they have just saved is 156px off the top
 * of the screen. No code scrolled: the panel got shorter above them. At
 * rest a browser with scroll anchoring hides that shift; one without it
 * does not, so the second run switches anchoring off.
 */
for (const anchoring of [true, false]) {
  test(`saving a setting never moves the page, and the panel scrolls to itself once only (scroll anchoring ${anchoring ? "on" : "off"})`, async ({ page, db }) => {
    await db.run(`UPDATE "Organisation" SET "benchPickMode" = 'first-come', language = 'en' WHERE id = $1`, [ORG_ID]);
    // Everything that can change the panel's height: a card that goes when
    // it is resolved (the fee, with its "From your group description"
    // caption; organisers pick; the language), and a description caption
    // on a switched setting.
    await db.run(`UPDATE "Activity" SET "feePerPlayer" = NULL, "feeSplitTotal" = false WHERE "orgId" = $1`, [ORG_ID]);
    await db.run(`UPDATE "ClubSetupLearning" SET applied = $2::jsonb, suggestions = $3::jsonb WHERE "orgId" = $1`, [
      ORG_ID,
      JSON.stringify([
        {
          key: "rollingSquad",
          from: false,
          to: true,
          evidence: ["Same lot as last week", "Same squad every week unless you say out"],
          fromDescription: ["Same squad every week unless you say out"],
          undoneAt: null,
        },
      ]),
      JSON.stringify([
        {
          key: "matchFee",
          current: "",
          detected: "6.50",
          evidence: ["£6.50 a player, pay before kick off"],
          fromDescription: ["£6.50 a player, pay before kick off"],
        },
        { key: "language", current: "en", detected: "tr", evidence: [] },
        {
          key: "organiserPicks",
          current: "first-come",
          detected: "organiser",
          evidence: ["Drop me a message and I'll sort the team", "I'll pick someone off the reserve list"],
        },
      ]),
    ]);
    await page.clock.install();
    // Every scroll the panel asks for, for the life of the page.
    await page.addInitScript((anchor) => {
      const w = window as unknown as { __panelScrolls: string[] };
      w.__panelScrolls = [];
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<typeof original>) {
        if (this.id.startsWith("learned-")) w.__panelScrolls.push(this.id);
        return original.apply(this, args);
      };
      if (!anchor) {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = "* { overflow-anchor: none !important; }";
          document.head.appendChild(style);
        });
      }
    }, anchoring);
    const panelScrolls = () => page.evaluate(() => (window as unknown as { __panelScrolls: string[] }).__panelScrolls);
    const loads = countRequestsOf(page, (body) => body.includes('"suggestions"') && body.includes('"applied"'));
    /** Put a control in the middle of the screen, at once, as a finger would. */
    const goTo = (css: string) =>
      page.evaluate((sel) => document.querySelector(sel)!.scrollIntoView({ behavior: "instant", block: "center" }), css);
    /** Where a control is on the screen, and how far the page is scrolled. */
    const where = (css: string) =>
      page.evaluate(
        (sel) => ({ top: Math.round(document.querySelector(sel)!.getBoundingClientRect().top), scrollY: Math.round(window.scrollY) }),
        css,
      );
    /** The page has done everything it was going to: what is queued has run, and every timer. */
    const turn = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => done();
            channel.port2.postMessage(null);
          }),
      );
    const settle = async () => {
      await turn();
      await page.clock.runFor(2_000);
      await turn();
    };
    /**
     * The panel's n-th load since the count was reset has been ANSWERED
     * and taken in. Not merely sent: `waitForLoadState("networkidle")`
     * returns at once on a page that has been idle before, so a step that
     * went on while the answer was still on its way met a panel that was
     * mid-load (about one run in sixty, the answer taking 160ms).
     */
    const loaded = async (n: number) => {
      await expect.poll(() => loads.done()).toBe(n);
      expect(loads.count()).toBe(n);
      await settle();
    };

    // The DM's link to a suggestion: the page scrolls to it. Once.
    await signInAs(page, U.admin, "/admin/settings?learned=organiserPicks#learned-setup");
    const pickCard = page.getByTestId("learned-suggestion-organiserPicks");
    await expect(pickCard).toHaveClass(/ring-2/, { timeout: 30_000 });
    await expect(pickCard).toBeInViewport({ ratio: 1 });
    await expect.poll(() => loads.known()).toBe(true);
    await page.waitForLoadState("networkidle");
    await settle();
    expect(await panelScrolls()).toEqual(["learned-organiserPicks"]);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflowAnchor)).toBe(anchoring ? "auto" : "none");
    loads.reset();

    // A weekly deadline, saved where it is (its card opened first: the
    // settings are tabs of collapsed cards since 2026-10-28).
    await openSettingsCard(page, "weekly-routine");
    await goTo(tid("wd-dropout"));
    let was = await where(tid("wd-dropout"));
    await page.getByTestId("wd-dropout-day").selectOption("1");
    await page.getByTestId("wd-dropout-time").fill("21:00");
    await page.getByTestId("wd-dropout-save").click();
    await expect
      .poll(() => db.one<{ d: number | null }>(`SELECT "dropOutDeadlineDay" AS d FROM "Organisation" WHERE id = $1`, [ORG_ID]))
      .toEqual({ d: 1 });
    await settle();
    expect(await where(tid("wd-dropout"))).toEqual(was);

    // Who fills an open place, saved where it is. The panel loads, and its
    // card would go: but the panel is off the top of the screen, so it waits.
    await openSettingsCard(page, "bench");
    await goTo(tid("wr-pick"));
    was = await where(tid("wr-pick"));
    await page.getByTestId("wr-pick-mode").selectOption("organiser");
    await loaded(1);
    expect(await where(tid("wr-pick"))).toEqual(was);
    await expect(pickCard).toHaveCount(1);

    // The language, saved where it is. The panel is 20px taller in
    // Turkish, so it stays in English, off the top of the screen, until
    // the organiser is back at it; the select stays under the finger.
    // On the Club tab the select sits close under the panel: with the
    // cards around it open (as an organiser reading the tab has them),
    // the select is far enough down that the panel is off the top of the
    // screen, which is what this step is about.
    await openSettingsCard(page, "club-details");
    await openSettingsCard(page, "whatsapp");
    await openSettingsCard(page, "bot-language");
    await goTo("#bot-language select");
    expect(await page.getByTestId("learned-setup").evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
    was = await where("#bot-language select");
    await page.locator("#bot-language select").selectOption("tr");
    // The page now speaks the language just chosen, its toast included.
    await expect(page.getByText("MatchTime bu grupta Türkçe konuşacak")).toBeVisible();
    await loaded(2);
    expect(await where("#bot-language select")).toEqual(was);
    await expect(page.getByRole("heading", { name: "Set up from your group chat" })).toHaveCount(1);

    // The match fee, set on the weekly game page while this page was left
    // open (as if in another tab), and the organiser comes back to it
    // still scrolled down here: the panel loads, the fee's card and its
    // description caption would go, and nothing moves.
    const feeCard = page.getByTestId("learned-suggestion-matchFee");
    await expect(feeCard.getByTestId("learned-evidence-description")).toHaveCount(1);
    await expect(page.getByTestId("learned-item-rollingSquad").getByTestId("learned-evidence-description")).toHaveCount(1);
    was = await where("#bot-language select");
    await db.run(`UPDATE "Activity" SET "feePerPlayer" = 6.5 WHERE "orgId" = $1`, [ORG_ID]);
    await page.clock.fastForward(6_000);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await loaded(3);
    expect(await where("#bot-language select")).toEqual(was);
    await expect(feeCard).toHaveCount(1);

    // Back up at the panel: now it shows what it loaded. Nothing the panel
    // did scrolled the page, then or since.
    await page.getByTestId("learned-setup").scrollIntoViewIfNeeded();
    await page.clock.runFor(1_000);
    await expect(page.getByTestId("learned-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("learned-resolved-matchFee")).toHaveText("Maç ücreti artık kişi başı £6.50.");
    await expect(page.getByTestId("learned-resolved-organiserPicks")).toHaveText('"Organizatörler seçer" ayarı açık.');
    await expect(page.getByTestId("learned-resolved-language")).toHaveText("MatchTime bu grupta artık Türkçe konuşuyor.");
    expect(await panelScrolls()).toEqual(["learned-organiserPicks"]);

    // THE RACE THAT WAS FOUND: the button, then the save before the page
    // has finished scrolling down to the setting. The whole row is on the
    // screen when everything has settled, and it stays there.
    await db.run(`UPDATE "Organisation" SET "benchPickMode" = 'first-come', language = 'en' WHERE id = $1`, [ORG_ID]);
    await page.goto("/admin/settings#learned-setup");
    await expect(pickCard).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await settle();
    loads.reset();
    const scrolledDown = await scrollEnd(page);
    await pickCard.getByRole("link", { name: 'Switch on "The organisers pick"' }).click();
    await page.getByTestId("wr-pick-mode").selectOption("organiser");
    await scrolledDown();
    await loaded(1);
    const rested = await where(tid("wr-pick"));
    // Where the link leaves it: the row at the top under its 24px margin,
    // or (since 2026-10-28) as far up as the short Players tab lets the
    // page scroll; never under the top edge, and the whole row on screen.
    expect(rested.top).toBeGreaterThanOrEqual(24);
    await expect(page.getByTestId("wr-pick")).toBeInViewport({ ratio: 1 });
    await page.clock.runFor(5_000);
    expect(await where(tid("wr-pick"))).toEqual(rested);
    // One scroll again on this visit (the `#learned-setup` arrival), none for the reload.
    expect(await panelScrolls()).toEqual(["learned-setup"]);
    await page.getByTestId("learned-setup").scrollIntoViewIfNeeded();
    await page.clock.runFor(1_000);
    await expect(page.getByTestId("learned-suggestion-organiserPicks")).toHaveCount(0);
  });
}

// Go-live slice D3 (2026-10-12): a quote found in the GROUP DESCRIPTION is
// shown under its own label, and the match fee is a thing to check whose
// button opens the weekly game's fee field.
test("description evidence has its own label, and the fee suggestion's button opens the fee field, which saves", async ({ page, db }) => {
  await db.run(`UPDATE "Activity" SET "feePerPlayer" = NULL WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(
    `UPDATE "Organisation" SET "rollingSquadEnabled" = false, "paymentTrackingEnabled" = false, language = 'en',
       "dropOutDeadlineDay" = 1, "dropOutDeadlineTime" = '21:00', "listPublishDay" = NULL, "listPublishTime" = NULL
     WHERE id = $1`,
    [ORG_ID],
  );
  await db.run(`UPDATE "ClubSetupLearning" SET applied = $2::jsonb, suggestions = $3::jsonb, noted = '[]'::jsonb WHERE "orgId" = $1`, [
    ORG_ID,
    JSON.stringify([
      {
        key: "dropOutDeadline",
        from: null,
        to: { day: 1, time: "21:00" },
        evidence: ["Drop out by Monday 9pm please", "Drop out by Monday 9pm or you still pay"],
        fromDescription: ["Drop out by Monday 9pm or you still pay"],
        undoneAt: null,
      },
    ]),
    JSON.stringify([
      {
        key: "matchFee",
        current: "",
        detected: "6.50",
        evidence: ["£6.50 a player, pay before kick off"],
        fromDescription: ["£6.50 a player, pay before kick off"],
      },
    ]),
  ]);

  await signInAs(page, U.admin, "/admin/settings#learned-setup");
  const item = page.getByTestId("learned-item-dropOutDeadline");
  await expect(item).toBeVisible({ timeout: 30_000 });
  // One line for the message, one for the description, never mixed.
  await expect(item.getByTestId("learned-evidence-chat")).toHaveText('From messages like: "Drop out by Monday 9pm please"');
  await expect(item.getByTestId("learned-evidence-description")).toHaveText(
    'From your group description: "Drop out by Monday 9pm or you still pay"',
  );

  const check = page.getByRole("region", { name: "1 thing to check" });
  const fee = page.getByTestId("learned-suggestion-matchFee");
  await expect(fee).toContainText("The match fee looks like £6.50 a player; your weekly game has no fee set.");
  await expect(fee.getByTestId("learned-evidence-description")).toHaveText(
    'From your group description: "£6.50 a player, pay before kick off"',
  );
  await expect(fee.getByTestId("learned-evidence-chat")).toHaveCount(0);
  await expect(check.getByRole("link")).toHaveAccessibleName("Set the match fee");
  await expect(fee.getByRole("link")).toHaveAttribute("href", "/admin/activities?edit=fee");
  await expectNoHorizontalOverflow(page);

  // The same in Turkish: both labels, the fee's line and its button.
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await page.reload();
    await expect(item.getByTestId("learned-evidence-chat")).toHaveText('Şu tür mesajlardan: "Drop out by Monday 9pm please"', {
      timeout: 30_000,
    });
    await expect(item.getByTestId("learned-evidence-description")).toHaveText(
      'Grup açıklamanızdan: "Drop out by Monday 9pm or you still pay"',
    );
    await expect(fee).toContainText("Maç ücreti kişi başı £6.50 gibi görünüyor; haftalık maçınızda ücret girilmemiş.");
    await expect(fee.getByTestId("learned-evidence-description")).toHaveText(
      'Grup açıklamanızdan: "£6.50 a player, pay before kick off"',
    );
    await expect(fee.getByRole("link", { name: "Maç ücretini gir" })).toHaveAttribute("href", "/admin/activities?edit=fee");
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
  await page.reload();

  // The button opens the weekly game's edit form at the fee field.
  await fee.getByRole("link", { name: "Set the match fee" }).click();
  await expect(page).toHaveURL(/\/admin\/activities\?edit=fee$/, { timeout: 30_000 });
  const field = page.getByTestId("activity-fee");
  await expect(field).toBeVisible({ timeout: 30_000 });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await expect(page.getByText("Fee per player (£), optional")).toBeVisible();

  // Not an amount: refused in words, nothing saved.
  await field.fill("six quid");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter a fee like 6 or 6.50, at most £100.")).toBeVisible();
  expect(await db.all(`SELECT 1 FROM "Activity" WHERE "orgId" = $1 AND "feePerPlayer" IS NOT NULL`, [ORG_ID])).toEqual([]);

  await field.fill("6.50");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(async () => db.all(`SELECT "feePerPlayer" AS fee FROM "Activity" WHERE "orgId" = $1 AND "feePerPlayer" IS NOT NULL`, [ORG_ID]))
    .toEqual([{ fee: 6.5 }]);
  await expect(page.getByTestId("activity-fee-row")).toContainText("£6.50 a player");
});

// Review fix 7 (PR #238): the fee field must not get in the way of an
// edit of something else, and a game that splits the pitch has no fee.
test("a stored fee the form cannot show exactly survives an edit of the venue; a split-pitch game has the field switched off", async ({ page, db }) => {
  // More decimals than the form shows, and (second) above its limit.
  for (const stored of [6.505, 250]) {
    await db.run(`UPDATE "Activity" SET "feePerPlayer" = $2, "feeSplitTotal" = false WHERE "orgId" = $1`, [ORG_ID, stored]);
    await signInAs(page, U.admin, "/admin/activities?edit=fee");
    const field = page.getByTestId("activity-fee");
    await expect(field).toBeVisible({ timeout: 30_000 });
    const venue = page.locator("form").filter({ has: field }).locator("input").nth(2);
    await venue.fill(`Goals ${stored}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => db.all(`SELECT venue, "feePerPlayer" AS fee FROM "Activity" WHERE "orgId" = $1 AND venue = $2`, [ORG_ID, `Goals ${stored}`]))
      .toEqual([{ venue: `Goals ${stored}`, fee: stored }]);
  }

  await db.run(`UPDATE "Activity" SET "feePerPlayer" = NULL, "feeSplitTotal" = true WHERE "orgId" = $1`, [ORG_ID]);
  await signInAs(page, U.admin, "/admin/activities?edit=fee");
  const field = page.getByTestId("activity-fee");
  await expect(field).toBeVisible({ timeout: 30_000 });
  await expect(field).toBeDisabled();
  await expect(page.getByTestId("activity-fee-hint")).toHaveText(
    "This game splits the pitch cost between who played, so there is no fixed fee per player.",
  );
  // The rest of the form still saves.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(field).toHaveCount(0);
  expect(await db.all(`SELECT 1 FROM "Activity" WHERE "orgId" = $1 AND "feePerPlayer" IS NOT NULL`, [ORG_ID])).toEqual([]);
  await db.run(`UPDATE "Activity" SET "feeSplitTotal" = false WHERE "orgId" = $1`, [ORG_ID]);
});
