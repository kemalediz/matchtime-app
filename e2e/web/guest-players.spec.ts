/**
 * The Guest players page, the match page's Guest tags and the guest card,
 * and the Style of play setting (local player pool, slice L5b).
 *
 * The world: a pool guest (Ali Khan, booked for the upcoming match, played
 * yesterday's, no-show ten days ago at another venue), a partner guest from
 * before the pool with no GuestPlace row (Bob, played the pay match), a
 * partner guest who has since joined (Cem), and a partner guest on the bench
 * of the upcoming match (Dan). Pool asks on yesterday's match (filled, Ali
 * played: rescued) and on a cancelled match (not rescued).
 *
 * Privacy: Ali's phone, his area (SM9) and the other club he plays for
 * (Secret Third FC) never reach any tab, the card or the CSV.
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const P = "e2e-gp";
const PARTNER = `${P}-partner`;
const THIRD = `${P}-third`;
const ALI = `${P}-ali`;
const BOB = `${P}-bob`;
const CEM = `${P}-cem`;
const DAN = `${P}-dan`;
const OLD = `${P}-m-old`;
const CANCELLED = `${P}-m-cancel`;
const SECRETS = ["+447700900981", "07700900981", "7700900981", "SM9", "Secret Third FC", "+447700900982"];

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

async function seedGuests(db: import("../helpers/test-db").TestDb) {
  const day = 24 * 60 * 60 * 1000;
  for (const [id, name] of [
    [PARTNER, "Sutton Lenders"],
    [THIRD, "Secret Third FC"],
  ]) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","createdAt","updatedAt") VALUES ($1,$2,$1,$3,'approved',now(),now())`,
      [id, name, `${id}-invite`],
    );
  }
  for (const [id, name, phone] of [
    [ALI, "Ali Khan", "+447700900981"],
    [BOB, "Bob Lender", "+447700900982"],
    [CEM, "Cem Joined", "+447700900983"],
    [DAN, "Dan Partner", "+447700900984"],
  ]) {
    await db.run(`INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`, [
      id,
      name,
      `${id}@e2e-test.invalid`,
      phone,
    ]);
  }

  // A second activity at another venue, 7-a-side, with a match ten days ago.
  await db.run(
    `INSERT INTO "Sport" (id,"orgId",name,"playersPerTeam",positions,"teamLabels","updatedAt") VALUES ($1,$2,'Football 7-a-side',7,'{}','{}',now())`,
    [`${P}-sport7`, ORG_ID],
  );
  await db.run(
    `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek","time",venue,"updatedAt") VALUES ($1,$2,$3,'E2E 7-a-side',4,'19:00','Powerleague Sutton',now())`,
    [`${P}-act7`, ORG_ID, `${P}-sport7`],
  );
  const insertMatch = (id: string, activity: string, date: Date, status: string) =>
    db.run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,$2,$3,14,$4::"MatchStatus",$3,now())`,
      [id, activity, date, status],
    );
  await insertMatch(OLD, `${P}-act7`, new Date(Date.now() - 10 * day), "COMPLETED");
  await insertMatch(CANCELLED, ACTIVITY_ID, new Date(Date.now() - 5 * day), "CANCELLED");

  // Memberships: Ali a pool guest here and a player at another club; Bob a
  // past partner guest; Cem now an ordinary member; Dan a current partner guest.
  const member = (id: string, user: string, org: string, extra: { from?: string; match?: string; via?: string; left?: boolean } = {}) =>
    db.run(
      `INSERT INTO "Membership" (id,"userId","orgId",role,"guestFromOrgId","guestMatchId","guestVia","leftAt","createdAt") VALUES ($1,$2,$3,'PLAYER',$4,$5,$6,$7,now())`,
      [id, user, org, extra.from ?? null, extra.match ?? null, extra.via ?? null, extra.left ? new Date() : null],
    );
  await member(`${P}-m1`, ALI, ORG_ID, { match: MATCH.upcoming, via: "pool" });
  await member(`${P}-m2`, ALI, THIRD);
  await member(`${P}-m3`, BOB, ORG_ID, { from: PARTNER, match: MATCH.pay, left: true });
  await member(`${P}-m4`, BOB, PARTNER);
  await member(`${P}-m5`, CEM, ORG_ID);
  await member(`${P}-m6`, DAN, ORG_ID, { from: PARTNER, match: MATCH.upcoming });

  const attend = (id: string, match: string, user: string, status: string, position: number) =>
    db.run(
      `INSERT INTO "Attendance" (id,"matchId","userId",status,position,"createdAt","updatedAt") VALUES ($1,$2,$3,$4::"AttendanceStatus",$5,now(),now())`,
      [id, match, user, status, position],
    );
  await attend(`${P}-a1`, MATCH.upcoming, ALI, "CONFIRMED", 6);
  await attend(`${P}-a2`, MATCH.rate, ALI, "CONFIRMED", 6);
  await attend(`${P}-a3`, OLD, ALI, "CONFIRMED", 1);
  await attend(`${P}-a4`, MATCH.pay, BOB, "CONFIRMED", 9);
  await attend(`${P}-a5`, OLD, CEM, "CONFIRMED", 2);
  await attend(`${P}-a6`, MATCH.upcoming, DAN, "BENCH", 7);

  // Ali's pool profile: active, area SM9, football at an advanced level.
  await db.run(
    `INSERT INTO "PoolProfile" (id,"userId",status,"consentAt","consentVersion","consentChannel","consentEvidence","adultConfirmedAt","displayName","areaDistrict","areaLat","areaLng","updatedAt")
     VALUES ($1,$2,'active',now(),1,'whatsapp','wamid-e2e-gp',now(),'Ali K','SM9',51.36,-0.19,now())`,
    [`${P}-pp`, ALI],
  );
  await db.run(`INSERT INTO "PoolSport" (id,"profileId",sport,"otherName",level,formats) VALUES ($1,$2,'football','','advanced','{5}')`, [`${P}-ps`, `${P}-pp`]);

  const place = (id: string, match: string, user: string, source: string, from: string | null, result: string) =>
    db.run(
      `INSERT INTO "GuestPlace" (id,"orgId","matchId","userId",source,"fromOrgId",result,"resultAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [id, ORG_ID, match, user, source, from, result, result === "booked" ? null : new Date()],
    );
  await place(`${P}-g1`, MATCH.upcoming, ALI, "pool", null, "booked");
  await place(`${P}-g2`, MATCH.rate, ALI, "pool", null, "played");
  await place(`${P}-g3`, OLD, ALI, "pool", null, "no-show");
  await place(`${P}-g4`, OLD, CEM, "partner", PARTNER, "played");

  // Pool asks: yesterday's match (3 offers reached people, Ali played) and the cancelled one (2 offers).
  const ask = (id: string, match: string, status: string) =>
    db.run(`INSERT INTO "PoolAsk" (id,"matchId","orgId",places,via,status,"closedAt","updatedAt") VALUES ($1,$2,$3,1,'page',$4,now(),now())`, [id, match, ORG_ID, status]);
  await ask(`${P}-k1`, MATCH.rate, "filled");
  await ask(`${P}-k2`, CANCELLED, "closed");
  let n = 0;
  for (const [askId, match, user] of [
    [`${P}-k1`, MATCH.rate, ALI],
    [`${P}-k1`, MATCH.rate, `${P}-x1`],
    [`${P}-k1`, MATCH.rate, `${P}-x2`],
    [`${P}-k2`, CANCELLED, `${P}-x1`],
    [`${P}-k2`, CANCELLED, `${P}-x2`],
  ]) {
    await db.run(
      `INSERT INTO "PoolOffer" (id,"poolAskId","matchId","orgId","userId","distanceMiles","sentAt","expiresAt",outcome,"resolvedAt") VALUES ($1,$2,$3,$4,$5,1.2,now(),now(),'expired',now())`,
      [`${P}-o${n++}`, askId, match, ORG_ID, user],
    );
  }
}

/** The page holds none of the secrets, in its text or its markup. */
async function expectNoSecrets(page: Page) {
  const html = await page.content();
  for (const s of SECRETS) expect(html, `leaked ${s}`).not.toContain(s);
}

async function expectNoSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(1);
}

test.beforeAll(() => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test("empty states: no guests, no tab in the admin menu, every tab says so", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/guests");
  await expect(page.getByTestId("guest-players-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Guest players" })).toHaveCount(0);
  await expect(page.getByTestId("guest-empty-upcoming")).toHaveText("No guest is booked for your coming games.");
  await page.getByTestId("guest-tab-history").click();
  await expect(page.getByTestId("guest-empty-history")).toHaveText("No guest has played with your club yet.");
  await page.getByTestId("guest-tab-report").click();
  await expect(page.getByTestId("guest-empty-report")).toBeVisible();
});

test("a player of the club cannot open the page or the CSV", async ({ page, db }) => {
  await seedGuests(db);
  await signInAs(page, U.player, "/admin/guests");
  await page.waitForURL((u) => !u.pathname.startsWith("/admin"), { timeout: 30_000 });
  expect(new URL(page.url()).pathname).not.toContain("/admin/guests");
  const res = await page.request.get("/admin/guests/report.csv?period=season");
  expect(res.status()).toBe(403);
  expect(await res.text()).not.toContain("Ali");
});

for (const [label, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`Upcoming (${label}): guests grouped by match, source, turn-up record, bench`, async ({ page }) => {
    await page.setViewportSize(size);
    await signInAs(page, U.admin, "/admin");
    await page.getByRole("link", { name: "Guest players" }).click();
    await expect(page.getByTestId("guest-players-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("guest-tab-upcoming")).toHaveAttribute("aria-current", "page");
    const groups = page.getByTestId("guest-upcoming-match");
    await expect(groups).toHaveCount(1);
    await expect(groups.first().getByRole("heading")).toContainText("E2E Arena");
    await expect(groups.first().getByRole("heading")).toContainText("Kickoff 20:00");
    const rows = groups.first().getByTestId("guest-upcoming-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Ali K");
    await expect(rows.nth(0)).toContainText("MatchTime player pool");
    await expect(rows.nth(0)).toContainText("Turned up to 1 of 2 games");
    await expect(rows.nth(1)).toContainText("Dan P");
    await expect(rows.nth(1)).toContainText("From Sutton Lenders");
    await expect(rows.nth(1)).toContainText("New to MatchTime");
    await expect(rows.nth(1).getByTestId("guest-on-bench")).toHaveText("On the bench");
    await expectNoSecrets(page);
    await expectNoSideScroll(page);
  });

  test(`History (${label}): every past guest, each game's result, joined or not`, async ({ page }) => {
    await page.setViewportSize(size);
    await signInAs(page, U.admin, "/admin/guests?tab=history");
    const rows = page.getByTestId("guest-history-row");
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    // Newest game first: Bob (the pay match, hours ago), Ali (yesterday), Cem (ten days ago).
    await expect(rows.nth(0)).toContainText("Bob L");
    await expect(rows.nth(0).getByTestId("guest-history-game")).toHaveAttribute("data-result", "played");
    await expect(rows.nth(0).getByTestId("guest-joined")).toHaveText("Not a member");
    await expect(rows.nth(1)).toContainText("Ali K");
    await expect(rows.nth(1).getByTestId("guest-history-game")).toHaveCount(2);
    await expect(rows.nth(1).getByTestId("guest-history-game").nth(0)).toContainText("Played");
    await expect(rows.nth(1).getByTestId("guest-history-game").nth(1)).toContainText("No-show");
    await expect(rows.nth(1).getByTestId("guest-history-game").nth(1)).toContainText("Powerleague Sutton");
    await expect(rows.nth(2)).toContainText("Cem J");
    await expect(rows.nth(2).getByTestId("guest-joined")).toHaveText("Joined the club");
    await expectNoSecrets(page);
    await expectNoSideScroll(page);
  });

  test(`the guest card (${label}): name, sports, level, record, games here, nothing private`, async ({ page }) => {
    await page.setViewportSize(size);
    await signInAs(page, U.admin, "/admin/guests?tab=history");
    await page.getByRole("button", { name: "About Ali K" }).click();
    const card = page.getByTestId("guest-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("guest-card-name")).toHaveText("Ali K");
    await expect(card.getByTestId("guest-card-sports")).toHaveText("Football, Advanced");
    await expect(card.getByTestId("guest-card-record")).toHaveText("Turned up to 1 of 2 games");
    await expect(card.getByTestId("guest-card-games")).toHaveText("1 game with your club");
    await expect(card.getByTestId("guest-card-source")).toHaveText("MatchTime player pool");
    // Invite to club (L8) shows only for a club with the pool on.
    await expect(card.getByTestId("guest-invite")).toHaveCount(0);
    await expectNoSecrets(page);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("button", { name: "About Ali K" })).toBeFocused();
  });
}

test("Report: totals, the fill rate, month and season, sport and venue filters", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/guests?tab=report&period=season");
  const total = page.getByTestId("guest-report-total");
  await expect(total).toBeVisible({ timeout: 30_000 });
  // Asked 5, accepted 6, played 3, no-shows 1, became members 1, short 2, rescued 1, 50%.
  await expect(total.locator("td")).toHaveText(["5", "6", "3", "1", "1", "2", "1", "50%"]);
  await expect(page.getByTestId("guest-report-row")).toHaveCount(1);
  await expect(page.getByTestId("guest-report-row").first().getByRole("rowheader")).toHaveText(/^Season \d{4}\/\d{2}$/);
  await expect(page.getByTestId("guest-report-help")).toContainText("fill rate");

  await page.getByTestId("guest-report-period").selectOption("month");
  await page.getByTestId("guest-report-apply").click();
  await page.waitForURL(/period=month/);
  await expect(page.getByTestId("guest-report-row").first().getByRole("rowheader")).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
  await expect(total.locator("td")).toHaveText(["5", "6", "3", "1", "1", "2", "1", "50%"]);

  await page.getByTestId("guest-report-sport").selectOption({ label: "Football 7-a-side" });
  await page.getByTestId("guest-report-apply").click();
  await page.waitForURL(/sport=/);
  await expect(total.locator("td")).toHaveText(["0", "2", "1", "1", "1", "0", "0", "None"]);

  await page.getByTestId("guest-report-sport").selectOption({ label: "All" });
  await page.getByTestId("guest-report-venue").selectOption("E2E Arena");
  await page.getByTestId("guest-report-apply").click();
  await page.waitForURL(/venue=E2E/);
  await expect(total.locator("td")).toHaveText(["5", "4", "2", "0", "0", "2", "1", "50%"]);
  await expectNoSecrets(page);
});

test("Report at phone width: the table scrolls inside its card, the page does not", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signInAs(page, U.admin, "/admin/guests?tab=report&period=month");
  await expect(page.getByTestId("guest-report-table")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("guest-report-csv")).toBeVisible();
  await expectNoSideScroll(page);
});

test("Report: the CSV download matches the table", async ({ page }) => {
  await signInAs(page, U.admin, "/admin/guests?tab=report&period=season");
  await expect(page.getByTestId("guest-report-total")).toBeVisible({ timeout: 30_000 });
  const download = page.waitForEvent("download");
  await page.getByTestId("guest-report-csv").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("guest-players-season.csv");
  const csv = readFileSync((await file.path())!, "utf8").replace(/^﻿/, "");
  const lines = csv.trimEnd().split("\r\n");
  expect(lines[0]).toBe("Period,Asked,Accepted,Played,No-shows,Became members,Short games,Rescued,Fill rate");
  expect(lines[1]).toMatch(/^Season \d{4}\/\d{2},5,6,3,1,1,2,1,50%$/);
  expect(lines.at(-1)).toBe("Total,5,6,3,1,1,2,1,50%");
  for (const s of SECRETS) expect(csv).not.toContain(s);
});

test("the match page tags guests; an organiser's tag opens the card", async ({ page }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  const section = page.getByTestId("attendance-section");
  await expect(section.getByTestId("guest-tag")).toHaveCount(2, { timeout: 30_000 });
  await section.getByRole("button", { name: "About Ali K" }).click();
  const card = page.getByTestId("guest-card");
  await expect(card.getByTestId("guest-card-sports")).toHaveText("Football, Advanced");
  await expect(card.getByTestId("guest-card-record")).toHaveText("Turned up to 1 of 2 games");
  await expect(card).not.toContainText("SM9");
  await expect(card).not.toContainText("Secret Third FC");
  await expect(card).not.toContainText("7700900981");
});

test("a player sees the Guest tags but no card", async ({ page }) => {
  await signInAs(page, U.player, `/matches/${MATCH.upcoming}`);
  const section = page.getByTestId("attendance-section");
  await expect(section.getByTestId("guest-tag")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("guest-card-open")).toHaveCount(0);
  await expectNoSecrets(page);
});

test("a Turkish club reads the page in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await signInAs(page, U.admin, "/admin/guests");
    await expect(page.getByRole("heading", { name: "Misafir oyuncular" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("guest-tab-history")).toHaveText("Geçmiş");
    await expect(page.getByTestId("guest-upcoming-row").first()).toContainText("MatchTime oyuncu havuzu");
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("Style of play: shown only while the club may ask the pool, and saved", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/settings");
  await expect(page.getByTestId("weekly-routine")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("play-style")).toHaveCount(0);

  await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = true WHERE id = $1`, [ORG_ID]);
  try {
    await page.reload();
    const select = page.getByRole("combobox", { name: "Style of play" });
    await expect(select).toBeVisible({ timeout: 30_000 });
    await expect(select).toHaveValue("");
    await expect(page.getByTestId("info-setting-playStyle")).toBeVisible();
    await select.selectOption("competitive");
    await expect
      .poll(async () => (await db.one<{ s: string | null }>(`SELECT "playStyle" AS s FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.s, { timeout: 15_000 })
      .toBe("competitive");
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Style of play" })).toHaveValue("competitive", { timeout: 30_000 });
    await page.getByRole("combobox", { name: "Style of play" }).selectOption("");
    await expect
      .poll(async () => (await db.one<{ s: string | null }>(`SELECT "playStyle" AS s FROM "Organisation" WHERE id = $1`, [ORG_ID]))?.s, { timeout: 15_000 })
      .toBeNull();
  } finally {
    await db.run(`UPDATE "Organisation" SET "featurePlayerPool" = false, "playStyle" = NULL WHERE id = $1`, [ORG_ID]);
  }
});
