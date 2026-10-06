/**
 * Monthly squad, slice 2 (MDs/monthly-squad-plan-2026-10-05.md, sections
 * 9.1, 9.2 and 4.5): the "Monthly squad" settings section and the
 * /admin/months page.
 *
 *   - mode OFF (every club by default): the settings section is one
 *     switch, there is no Months tab, and /admin/months is a 404;
 *   - an OWNER switches it on, the rolling squad goes off with it, and
 *     the settings save, reload and refuse a bad value;
 *   - an ADMIN sees the empty month and starts it part-way through by
 *     ticking players: regulars, who has paid, PAYG, credits carried in;
 *   - a PLAYER reaches none of it;
 *   - Turkish club, Turkish words;
 *   - nothing is ever queued for WhatsApp.
 *
 * No model is called anywhere in this spec.
 */
import type { Page } from "@playwright/test";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import { testDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

/** "October 2026": the current London month, as the page words it. */
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "Europe/London" }).format(new Date());

async function setMode(mode: "weekly" | "monthly") {
  await testDb().run(`UPDATE "Organisation" SET "squadMode" = $2 WHERE id = $1`, [ORG_ID, mode]);
}

async function wipeMonths() {
  await testDb().run(`DELETE FROM "SquadCredit" WHERE "orgId" = $1`, [ORG_ID]);
  await testDb().run(`DELETE FROM "SquadMonth" WHERE "orgId" = $1`, [ORG_ID]);
}

async function outbound(): Promise<number> {
  const db = testDb();
  return (await db.count(`SELECT COUNT(*) FROM "BotJob"`)) + (await db.count(`SELECT COUNT(*) FROM "SentNotification"`));
}

async function openSettings(page: Page, userId: string = U.admin) {
  await signInAs(page, userId, "/admin/settings");
  await page.waitForURL("**/admin/settings");
  await expect(page.getByTestId("monthly-squad")).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(() => resetDb());
test.afterAll(() => resetDb());

test("mode off: one switch on settings, no Months tab, and /admin/months is a 404", async ({ page, db }) => {
  await openSettings(page);
  const section = page.getByTestId("monthly-squad");
  await expect(section.getByRole("heading", { name: "Monthly squad" })).toBeVisible();
  await expect(page.getByTestId("msq-mode")).toHaveValue("weekly");
  // Nothing but the switch: no price, no credits, no instructions, no notes.
  for (const id of ["msq-payg", "msq-opens", "msq-credit-rule", "msq-instructions", "msq-save", "msq-notes"]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  // The weekly routine is exactly as it was: the rolling squad row is there.
  await expect(page.getByTestId("wr-rolling")).toBeVisible();
  await expect(page.getByRole("link", { name: "Months", exact: true })).toHaveCount(0);

  const res = await page.goto("/admin/months");
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId("months-page")).toHaveCount(0);

  const org = await db.one<{ squadMode: string }>(`SELECT "squadMode" FROM "Organisation" WHERE id = $1`, [ORG_ID]);
  expect(org?.squadMode).toBe("weekly");
});

test("the section and every control has its info button", async ({ page }) => {
  await setMode("monthly");
  await openSettings(page);
  for (const k of ["st_monthly", "msq_mode", "msq_credit", "msq_payg", "msq_opens", "msq_instructions"]) {
    await expect(page.getByTestId(`info-${k}`), k).toBeVisible();
  }
  await page.getByTestId("info-st_monthly").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Monthly squad" })).toBeVisible();
  await expect(sheet).toContainText("It is off until you switch it on");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await setMode("weekly");
});

test("an owner switches it on: rolling squad goes off, the settings save and survive a reload", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET "rollingSquadEnabled" = true WHERE id = $1`, [ORG_ID]);
  const before = await outbound();
  await openSettings(page);

  await page.getByTestId("msq-mode").selectOption("monthly");
  await expect(page.getByTestId("msq-notes")).toContainText("Rolling squad is switched off while your squad is monthly");
  // Slice 5 posts the list in the group, so the "does not post the monthly
  // list in your group yet" note is gone; the link to the page stays.
  await expect(page.getByTestId("msq-notes")).not.toContainText("does not post");
  await expect(page.getByTestId("msq-months-link")).toBeVisible();
  await expect
    .poll(async () =>
      db.one<{ squadMode: string; rollingSquadEnabled: boolean }>(
        `SELECT "squadMode", "rollingSquadEnabled" FROM "Organisation" WHERE id = $1`,
        [ORG_ID],
      ),
    )
    .toEqual({ squadMode: "monthly", rollingSquadEnabled: false });
  // The rolling squad row is gone from the weekly routine; the rest of it stays.
  await expect(page.getByTestId("wr-rolling")).toHaveCount(0);
  await expect(page.getByTestId("wr-pick")).toBeVisible();

  await page.getByTestId("msq-payg").fill("8");
  await page.getByTestId("msq-opens").fill("10");
  await page.getByTestId("msq-instructions").fill("Bank details are in the group description.");
  await page.getByTestId("msq-save").click();
  await expect
    .poll(async () =>
      db.one(
        `SELECT "paygPricePence", "monthListOpensDaysBefore", "paymentInstructions" FROM "Organisation" WHERE id = $1`,
        [ORG_ID],
      ),
    )
    .toEqual({ paygPricePence: 800, monthListOpensDaysBefore: 10, paymentInstructions: "Bank details are in the group description." });

  await page.getByTestId("msq-credit-rule").selectOption("filled-only");
  await expect
    .poll(async () => (await db.one<{ r: string }>(`SELECT "monthCreditRule" AS r FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.r)
    .toBe("filled-only");

  await page.reload();
  await expect(page.getByTestId("msq-mode")).toHaveValue("monthly", { timeout: 30_000 });
  await expect(page.getByTestId("msq-payg")).toHaveValue("8.00");
  await expect(page.getByTestId("msq-opens")).toHaveValue("10");
  await expect(page.getByTestId("msq-credit-rule")).toHaveValue("filled-only");
  await expect(page.getByTestId("msq-instructions")).toHaveValue("Bank details are in the group description.");
  // The Months tab is there now, and the section links to the page.
  await expect(page.getByRole("link", { name: "Months", exact: true })).toBeVisible();
  await page.getByTestId("msq-months-link").click();
  await page.waitForURL("**/admin/months");

  expect(await outbound()).toBe(before);
});

test("a bad price is refused with a reason and nothing is saved", async ({ page, db }) => {
  await openSettings(page);
  await page.getByTestId("msq-payg").fill("eight quid");
  await page.getByTestId("msq-save").click();
  await expect(page.getByTestId("msq-error")).toHaveText("Enter a price like 8 or 7.50, up to £100.");
  await page.getByTestId("msq-payg").fill("8");
  await page.getByTestId("msq-opens").fill("40");
  await page.getByTestId("msq-save").click();
  await expect(page.getByTestId("msq-error")).toHaveText("Enter a whole number of days from 1 to 28.");
  const org = await db.one(`SELECT "paygPricePence", "monthListOpensDaysBefore" FROM "Organisation" WHERE id = $1`, [ORG_ID]);
  expect(org).toEqual({ paygPricePence: 800, monthListOpensDaysBefore: 10 });
});

test("a player reaches neither the page nor the settings, even in a monthly club", async ({ page, request }) => {
  await signInAs(page, U.player, "/admin/months");
  await expect(page).not.toHaveURL(/\/admin/);
  await expect(page.getByTestId("months-page")).toHaveCount(0);
  await page.goto("/admin/settings");
  await expect(page).not.toHaveURL(/\/admin/);
  // The settings API tells a player nothing about the monthly squad.
  const body = (await (await page.request.get("/api/org/settings")).json()) as Record<string, unknown>;
  expect(body.name).toBe("E2E Test FC");
  expect(body).not.toHaveProperty("monthlySquad");
  void request;
});

test("an admin sees the empty month, with its info button", async ({ page, db }) => {
  await wipeMonths();
  await db.run(`UPDATE "Membership" SET role = 'ADMIN' WHERE id = 'e2e-mem-collector'`);
  await signInAs(page, U.collector, "/admin/months");
  await page.waitForURL("**/admin/months");
  await expect(page.getByTestId("months-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("months-page").locator("h2")).toContainText("Months");

  const card = page.getByTestId("month-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-activity", ACTIVITY_ID);
  await expect(card.getByRole("heading", { name: `${MONTH}: E2E 5-a-side` })).toBeVisible();
  await expect(card.getByTestId("month-empty")).toContainText(`${MONTH} hasn't been started yet`);
  await expect(card.getByTestId("month-status")).toHaveCount(0);
  await expect(card.getByTestId("month-members")).toHaveCount(0);
  await expect(card.getByTestId("start-count")).toHaveText("On the list: 0 regulars, 0 PAYG");

  await page.getByTestId("info-mth_start").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Starting part-way through a month" })).toBeVisible();
  await expect(sheet).toContainText("Games already played this month count as played for the regulars you tick");
  await sheet.getByRole("button", { name: "Close" }).click();
  for (const k of ["mth_page", "mth_paid", "mth_credits"]) await expect(page.getByTestId(`info-${k}`), k).toBeVisible();

  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth"`)).toBe(0);
});

test("an admin starts the month by pasting the group's list: paid marks are only ever 'says paid'", async ({ page, db }) => {
  const before = await outbound();
  await signInAs(page, U.collector, "/admin/months");
  await expect(page.getByTestId("start-month-form")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("info-mth_paste")).toBeVisible();

  // Prose is not a list, and reading it changes nothing.
  await page.getByTestId("start-paste-text").fill("£22.50 for 4 games next month, pay by Friday");
  await page.getByTestId("start-paste-read").click();
  await expect(page.getByTestId("start-paste-error")).toHaveText(
    "That doesn't look like a list. Paste the whole numbered list from your group.",
  );
  await expect(page.getByTestId("start-count")).toHaveText("On the list: 0 regulars, 0 PAYG");

  // "Patso" is Pat Player's known alias; there are two Omars; nobody is called Zed.
  const monthName = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "Europe/London" }).format(new Date());
  await page.getByTestId("start-paste-text").fill(
    [
      `List for ${monthName}:`,
      "",
      "1. Patso (Paid £30)",
      "2. Riley paid",
      "3. Ben (PAYG)",
      "4.",
      "5. Omar",
      "6. Zed",
      "",
      "Paid but can't play",
      "1. Tom",
    ].join("\n"),
  );
  await page.getByTestId("start-paste-read").click();
  await expect(page.getByTestId("start-paste-note")).toContainText("Players read from your list: 4.");
  await expect(page.getByTestId("start-paste-unmatched")).toContainText("Not matched to a player: Omar, Zed.");
  await expect(page.getByTestId("start-paste-month")).toHaveCount(0);
  await expect(page.getByTestId("start-count")).toHaveText("On the list: 3 regulars, 1 PAYG");
  // Reading the list has saved nothing.
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth"`)).toBe(0);

  const rowOf = (userId: string) => page.locator(`[data-testid="start-row"][data-user="${userId}"]`);
  await expect(rowOf(U.player).getByRole("checkbox")).toBeChecked();
  await expect(rowOf(U.player).getByTestId("start-paid")).toHaveValue("claimed");
  await expect(rowOf(U.player).getByTestId("start-amount")).toHaveValue("30.00");
  await expect(rowOf(U.rater).getByTestId("start-paid")).toHaveValue("claimed");
  await expect(rowOf(U.bench).getByTestId("start-kind")).toHaveValue("payg");
  // "Paid but can't play": a paid regular who is out this week.
  await expect(rowOf(U.third).getByRole("checkbox")).toBeChecked();
  await expect(rowOf(U.third).getByTestId("start-paid")).toHaveValue("claimed");
  await expect(rowOf(U.omar1).getByRole("checkbox")).not.toBeChecked();
  await expect(rowOf(U.omar2).getByRole("checkbox")).not.toBeChecked();

  await page.getByTestId("start-games").fill("4");
  await page.getByTestId("start-played").fill("1");
  await page.getByTestId("start-submit").click();
  await expect(page.getByTestId("month-members")).toBeVisible({ timeout: 30_000 });

  const members = await db.all<Record<string, unknown>>(
    `SELECT m."userId", m.kind, m.slot, m.source, m."paidClaimSource", m."paidClaimedAmountPence",
            (m."paidAt" IS NOT NULL) AS confirmed, (m."paidClaimedAt" IS NOT NULL) AS claimed
       FROM "SquadMonthMember" m JOIN "SquadMonth" sm ON sm.id = m."monthId" WHERE sm."orgId" = $1`,
    [ORG_ID],
  );
  const of = (userId: string) => members.find((m) => m.userId === userId);
  expect(members).toHaveLength(4);
  // Nobody is marked paid on a list's word.
  expect(members.every((m) => m.confirmed === false)).toBe(true);
  expect(members.every((m) => m.source === "seed-list")).toBe(true);
  // Slot numbers as written; the regular with no line of their own takes the free one.
  expect(of(U.player)).toMatchObject({ kind: "regular", slot: 1, claimed: true, paidClaimSource: "list", paidClaimedAmountPence: 3000 });
  expect(of(U.rater)).toMatchObject({ kind: "regular", slot: 2, claimed: true, paidClaimedAmountPence: null });
  expect(of(U.bench)).toMatchObject({ kind: "payg", slot: 3, claimed: false });
  expect(of(U.third)).toMatchObject({ kind: "regular", slot: 4, claimed: true });
  // The names the list used are saved as aliases of the players they were
  // matched to, so the group's later pastes of this list resolve by name
  // (a paste is matched by exact name or alias, never by guess). "Patso"
  // was Pat's alias already and stays his, once.
  const aliases = await db.all<{ alias: string; userId: string }>(
    `SELECT alias, "userId" FROM "UserAlias" WHERE "orgId" = $1 ORDER BY alias`,
    [ORG_ID],
  );
  expect(aliases).toEqual([
    { alias: "ben", userId: U.bench },
    { alias: "patso", userId: U.player },
    { alias: "riley", userId: U.rater },
    { alias: "tom", userId: U.third },
  ]);
  expect(await outbound()).toBe(before);

  await wipeMonths();
});

test("starting with nobody ticked is refused", async ({ page, db }) => {
  await signInAs(page, U.collector, "/admin/months");
  await expect(page.getByTestId("start-submit")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("start-submit").click();
  await expect(page.getByTestId("start-error")).toHaveText("Tick at least one player.");
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth"`)).toBe(0);
});

test("an admin starts the month part-way through by ticking players", async ({ page, db }) => {
  const before = await outbound();
  await signInAs(page, U.collector, "/admin/months");
  await expect(page.getByTestId("start-month-form")).toBeVisible({ timeout: 30_000 });

  // Four games this month, one already played, £7.50 a game.
  await page.getByTestId("start-games").fill("4");
  await page.getByTestId("start-played").fill("1");
  await page.getByTestId("start-share").fill("7.50");

  const rowOf = (userId: string) => page.locator(`[data-testid="start-row"][data-user="${userId}"]`);
  // Pat: a regular whose payment the organiser has seen.
  await rowOf(U.player).getByRole("checkbox").check();
  await rowOf(U.player).getByTestId("start-paid").selectOption("confirmed");
  await rowOf(U.player).getByTestId("start-amount").fill("30");
  // Riley: a regular who says they paid, with one game of credit carried in.
  await rowOf(U.rater).getByRole("checkbox").check();
  await rowOf(U.rater).getByTestId("start-paid").selectOption("claimed");
  await rowOf(U.rater).getByTestId("start-amount").fill("22.50");
  await rowOf(U.rater).getByTestId("start-credits").fill("1");
  // Tom: a regular who has not paid.
  await rowOf(U.third).getByRole("checkbox").check();
  // Ben: pay as you go. Nothing to pay for the month.
  await rowOf(U.bench).getByRole("checkbox").check();
  await rowOf(U.bench).getByTestId("start-kind").selectOption("payg");
  await expect(rowOf(U.bench).getByTestId("start-paid")).toBeDisabled();
  await expect(page.getByTestId("start-count")).toHaveText("On the list: 3 regulars, 1 PAYG");

  await page.getByTestId("start-submit").click();

  const card = page.getByTestId("month-card");
  await expect(card.getByTestId("month-members")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("month-status")).toHaveText("Running");
  await expect(card.getByTestId("month-started-mid")).toHaveText("Started part-way through the month. Games already played then: 1.");
  await expect(card.getByTestId("month-share")).toHaveText("Share per game: £7.50");
  await expect(card.getByTestId("start-month-form")).toHaveCount(0);

  const memberRow = (userId: string) => page.locator(`[data-testid="month-member"][data-user="${userId}"]`);
  await expect(memberRow(U.player)).toContainText("Pat Player");
  await expect(memberRow(U.player)).toContainText("Paid, confirmed (£30)");
  await expect(memberRow(U.rater)).toContainText("Says paid (£22.50)");
  await expect(memberRow(U.rater)).toContainText("£22.50");
  await expect(memberRow(U.third)).toContainText("Not paid");
  await expect(memberRow(U.third)).toContainText("£30");
  await expect(memberRow(U.bench)).toContainText("PAYG");

  const month = await db.one<Record<string, unknown>>(
    `SELECT id, status, "gamesScheduled", "gamesPlayedBeforeStart", "sharePerGamePence", "startedByUserId",
            ("startedMidMonthAt" IS NOT NULL) AS mid, to_char("monthStart", 'DD') AS day,
            ("listOpenedAt" IS NULL AND "pricedAt" IS NULL) AS unposted
       FROM "SquadMonth" WHERE "orgId" = $1 AND "activityId" = $2`,
    [ORG_ID, ACTIVITY_ID],
  );
  expect(month).toMatchObject({
    status: "running",
    gamesScheduled: 4,
    gamesPlayedBeforeStart: 1,
    sharePerGamePence: 750,
    startedByUserId: U.collector,
    mid: true,
    day: "01",
    unposted: true,
  });

  const members = await db.all<Record<string, unknown>>(
    `SELECT "userId", kind, slot, "gamesCovered", "creditsApplied", "amountDuePence", "paidAmountPence",
            ("paidAt" IS NOT NULL) AS confirmed, "paidConfirmedByUserId",
            ("paidClaimedAt" IS NOT NULL) AS claimed, "paidClaimedAmountPence", "paidClaimSource", source
       FROM "SquadMonthMember" WHERE "monthId" = $1`,
    [month!.id],
  );
  const of = (userId: string) => members.find((m) => m.userId === userId);
  expect(members).toHaveLength(4);
  // Games already played count as played: every regular covers all four.
  expect(of(U.player)).toMatchObject({
    kind: "regular",
    gamesCovered: 4,
    creditsApplied: 0,
    amountDuePence: 3000,
    confirmed: true,
    paidAmountPence: 3000,
    paidConfirmedByUserId: U.collector,
    claimed: false,
    source: "seed-tick",
  });
  // "Says paid" never sets paidAt.
  expect(of(U.rater)).toMatchObject({
    kind: "regular",
    gamesCovered: 4,
    creditsApplied: 1,
    amountDuePence: 2250,
    confirmed: false,
    paidAmountPence: null,
    claimed: true,
    paidClaimedAmountPence: 2250,
    paidClaimSource: "organiser",
  });
  expect(of(U.third)).toMatchObject({ kind: "regular", amountDuePence: 3000, confirmed: false, claimed: false });
  expect(of(U.bench)).toMatchObject({ kind: "payg", gamesCovered: 0, amountDuePence: null, confirmed: false, claimed: false });
  // Regulars take the first numbers, the PAYG player the next.
  expect(members.filter((m) => m.kind === "regular").map((m) => m.slot).sort()).toEqual([1, 2, 3]);
  expect(of(U.bench)?.slot).toBe(4);

  const credits = await db.all<Record<string, unknown>>(
    `SELECT "userId", games, reason, "appliedMonthId", ("appliedAt" IS NOT NULL) AS applied, "createdById"
       FROM "SquadCredit" WHERE "orgId" = $1`,
    [ORG_ID],
  );
  expect(credits).toEqual([
    { userId: U.rater, games: 1, reason: "carried-in", appliedMonthId: month!.id, applied: true, createdById: U.collector },
  ]);

  // Starting the month queued nothing for WhatsApp, and touched no match.
  expect(await outbound()).toBe(before);
  expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "paymentMethod" = 'monthly'`)).toBe(0);

  // It is still there after a reload, and cannot be started twice.
  await page.reload();
  await expect(card.getByTestId("month-members")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("start-month-form")).toHaveCount(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth"`)).toBe(1);
});

test("a Turkish club reads Turkish, on both pages", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await openSettings(page);
  const section = page.getByTestId("monthly-squad");
  await expect(section.getByRole("heading", { name: "Aylık kadro" })).toBeVisible();
  await expect(section).toContainText("Kadronuz nasıl oluşuyor");
  await expect(section).toContainText("Ödeme talimatı");
  await expect(page.getByRole("link", { name: "Aylar", exact: true })).toBeVisible();
  await page.getByTestId("info-msq_credit").click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Krediler" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Kapat" }).click();

  await page.goto("/admin/months");
  await expect(page.getByTestId("months-page").locator("h2")).toContainText("Aylar", { timeout: 30_000 });
  await expect(page.getByTestId("month-status")).toHaveText("Sürüyor");
  await expect(page.getByTestId("month-members")).toContainText("Ödedi, onaylandı");
  await expect(page.getByTestId("month-members")).toContainText("Maç başı (PAYG)");
  // No em or en dash anywhere on either page's new copy.
  expect(await page.getByTestId("months-page").innerText()).not.toMatch(/[—–]/);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("switching back to weekly hides the page again and keeps the month", async ({ page, db }) => {
  await openSettings(page);
  await page.getByTestId("msq-mode").selectOption("weekly");
  await expect
    .poll(async () => (await db.one<{ m: string }>(`SELECT "squadMode" AS m FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.m)
    .toBe("weekly");
  await expect(page.getByTestId("msq-payg")).toHaveCount(0);
  // The rolling squad row is back, and still off: the organiser decides.
  await expect(page.getByTestId("wr-rolling")).toBeVisible();
  await expect(page.getByTestId("wr-rolling").getByRole("switch")).toHaveAttribute("aria-checked", "false");

  const res = await page.goto("/admin/months");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("link", { name: "Months", exact: true })).toHaveCount(0);
  expect(await db.count(`SELECT COUNT(*) FROM "SquadMonth"`)).toBe(1);
});

test("the database refuses a squad mode that is not one of the two", async ({ db }) => {
  await expect(db.run(`UPDATE "Organisation" SET "squadMode" = 'yearly' WHERE id = $1`, [ORG_ID])).rejects.toThrow(
    /Organisation_squadMode_check/,
  );
  await expect(
    db.run(
      `INSERT INTO "SquadMonth" (id, "orgId", "activityId", "monthStart", "updatedAt") VALUES ('bad', $1, $2, '2026-10-05', now())`,
      [ORG_ID, ACTIVITY_ID],
    ),
  ).rejects.toThrow(/SquadMonth_monthStart_check/);
});
