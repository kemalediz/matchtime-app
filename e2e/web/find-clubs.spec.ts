/**
 * PARTNER DISCOVERY, slice P2: /admin/partners/find, end to end in a browser
 * against a real Postgres (2026-10-22). Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, sections 2.1 to 2.3.
 *
 *   - clubs seeded at known distances from our game's venue appear and
 *     disappear as the radius changes (1, 3, 5, 10 miles; 3 by default;
 *     a club 12 miles away never shows);
 *   - never listed: a club with "find us" off, one that blocked us, one
 *     that declined us 5 days ago; listed: a dormant club, a club with only
 *     a club venue ("No regular game yet");
 *   - each card: distance, game day, kickoff and format, member and regular
 *     player counts, and NO member name or phone number anywhere on the page;
 *   - a club we already ask shows "Already partners" instead of a checkbox;
 *   - "Plays on the same day as us";
 *   - tick, select all, the confirm, and Send (P3's action is a placeholder
 *     here: the page says it couldn't send);
 *   - a club with no venue sees "Confirm your venue"; with "find us" off it
 *     cannot search;
 *   - a PLAYER cannot open the page;
 *   - in Turkish.
 *
 * No model anywhere. No Google either: every venue is seeded with its
 * position.
 */
import type { Page } from "@playwright/test";
import { test, expect, resetDb, signInAs, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const KM_PER_MILE = 1.609344;
const HOME = { lat: 51.36, lng: -0.17 };
const north = (miles: number) => HOME.lat + (miles * KM_PER_MILE) / 111.195;
const PAGE = "/admin/partners/find";

interface Seed {
  id: string;
  name: string;
  miles: number;
  /** A weekly game at the venue; none means a club venue only. */
  game?: { dow: number; time: string; perSide: number };
  discoverable?: boolean;
  dormant?: boolean;
  members: number;
}

let phoneSeq = 0;
async function seedClub(db: TestDb, c: Seed): Promise<void> {
  await db.run(
    `INSERT INTO "Venue" (id,"placeId",name,"formattedAddress",lat,lng,source,"createdAt","updatedAt")
     VALUES ($1,$2,$3,'1 Test Road, Sutton SM1 1AA, UK',$4,$5,'google',now(),now())`,
    [`${c.id}-v`, `ChIJ_${c.id}`, `${c.name} Pitch`, north(c.miles), HOME.lng],
  );
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","whatsappGroupId","whatsappBotEnabled",discoverable,"dormantAt","homeVenueId","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',$4,true,$5,$6,$7,now(),now())`,
    [c.id, c.name, `${c.id}-invite`, `1203639${String(++phoneSeq).padStart(8, "0")}@g.us`, c.discoverable ?? true, c.dormant ? new Date() : null, c.game ? null : `${c.id}-v`],
  );
  if (c.game) {
    await db.run(
      `INSERT INTO "Sport" (id,"orgId",name,"playersPerTeam",positions,"teamLabels","updatedAt") VALUES ($1,$2,'Football',$3,'{GK,DEF,MID,FWD}','{Red,Yellow}',now())`,
      [`${c.id}-s`, c.id, c.game.perSide],
    );
    await db.run(
      `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek",time,venue,"venueId","updatedAt") VALUES ($1,$2,$3,'Weekly',$4,$5,'Pitch',$6,now())`,
      [`${c.id}-a`, c.id, `${c.id}-s`, c.game.dow, c.game.time, `${c.id}-v`],
    );
  }
  for (let i = 0; i < c.members; i++) {
    const uid = `${c.id}-u${i}`;
    await db.run(
      `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
      [uid, `Secret Person ${c.id} ${i}`, `${uid}@e2e-test.invalid`, `+4477009${String(50000 + ++phoneSeq)}`],
    );
    await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,$4,now())`, [
      `${uid}-m`,
      uid,
      c.id,
      i === 0 ? "OWNER" : "PLAYER",
    ]);
  }
}

const NEAR = "e2e-fc-near"; // 0.8 mi, Tuesdays
const PARTNER = "e2e-fc-partner"; // 1.2 mi, we already ask them
const DORMANT = "e2e-fc-dormant"; // 1.5 mi, dormant: still listed
const THREE = "e2e-fc-three"; // 2.5 mi, Thursdays
const FIVE = "e2e-fc-five"; // 4.5 mi, club venue only
const TEN = "e2e-fc-ten"; // 8 mi, Tuesdays
const FAR = "e2e-fc-far"; // 12 mi: never
const HIDDEN = "e2e-fc-hidden"; // 1 mi, find-us off: never
const BLOCKED = "e2e-fc-blocked"; // 1 mi, blocked us: never
const DECLINED = "e2e-fc-declined"; // 1 mi, declined us 5 days ago: never

const NAMES: Record<string, string> = {
  [NEAR]: "Near One FC",
  [PARTNER]: "Partner Pals FC",
  [DORMANT]: "Sleepy Dormant FC",
  [THREE]: "Three Mile FC",
  [FIVE]: "Five Mile FC",
  [TEN]: "Ten Mile FC",
  [FAR]: "Far Away FC",
  [HIDDEN]: "Hidden FC",
  [BLOCKED]: "Blocking FC",
  [DECLINED]: "Declining FC",
};

const cards = (page: Page) => page.getByTestId("nearby-club");
const card = (page: Page, id: string) => page.locator(`[data-testid="nearby-club"][data-org="${id}"]`);
async function shown(page: Page): Promise<string[]> {
  await expect(page.getByTestId("find-clubs")).toBeVisible({ timeout: 30_000 });
  return cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-org") ?? ""));
}

test.beforeAll(async ({ db }) => {
  resetDb();
  // Our game's venue.
  await db.run(
    `INSERT INTO "Venue" (id,"placeId",name,"formattedAddress",lat,lng,source,"createdAt","updatedAt") VALUES ('e2e-fc-home','ChIJ_e2e_fc_home','Our Arena','Our Road, Sutton SM2 5AT, UK',$1,$2,'google',now(),now())`,
    [HOME.lat, HOME.lng],
  );
  await db.run(`UPDATE "Activity" SET "venueId" = 'e2e-fc-home' WHERE id = $1`, [ACTIVITY_ID]);

  await seedClub(db, { id: NEAR, name: NAMES[NEAR], miles: 0.8, game: { dow: 2, time: "19:00", perSide: 7 }, members: 3 });
  await seedClub(db, { id: PARTNER, name: NAMES[PARTNER], miles: 1.2, game: { dow: 3, time: "20:00", perSide: 5 }, members: 2 });
  await seedClub(db, { id: DORMANT, name: NAMES[DORMANT], miles: 1.5, game: { dow: 3, time: "21:00", perSide: 6 }, dormant: true, members: 1 });
  await seedClub(db, { id: THREE, name: NAMES[THREE], miles: 2.5, game: { dow: 4, time: "18:30", perSide: 7 }, members: 2 });
  await seedClub(db, { id: FIVE, name: NAMES[FIVE], miles: 4.5, members: 1 });
  await seedClub(db, { id: TEN, name: NAMES[TEN], miles: 8, game: { dow: 2, time: "21:30", perSide: 5 }, members: 1 });
  await seedClub(db, { id: FAR, name: NAMES[FAR], miles: 12, game: { dow: 2, time: "20:00", perSide: 7 }, members: 1 });
  await seedClub(db, { id: HIDDEN, name: NAMES[HIDDEN], miles: 1, game: { dow: 2, time: "20:00", perSide: 7 }, discoverable: false, members: 1 });
  await seedClub(db, { id: BLOCKED, name: NAMES[BLOCKED], miles: 1, game: { dow: 2, time: "20:00", perSide: 7 }, members: 1 });
  await seedClub(db, { id: DECLINED, name: NAMES[DECLINED], miles: 1, game: { dow: 2, time: "20:00", perSide: 7 }, members: 1 });

  await db.run(`INSERT INTO "ClubBlock" (id,"blockerOrgId","blockedOrgId","createdByUserId") VALUES ('e2e-fc-block',$1,$2,'x')`, [BLOCKED, ORG_ID]);
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,origin,"askerAcceptedAt","createdByUserId","endedAt","endedByOrgId","endReason","createdAt","updatedAt")
     VALUES ('e2e-fc-decl',$1,$2,'ended','request',now(),$3,now() - interval '5 days',$2,'declined',now(),now())`,
    [ORG_ID, DECLINED, U.admin],
  );
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ('e2e-fc-pair',$1,$2,'active',now(),now(),$3,now(),now())`,
    [ORG_ID, PARTNER, U.admin],
  );
  // Near One's last games: two members played both, one played once.
  for (const m of [1, 2]) {
    await db.run(
      `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,$2,now() - ($3 || ' days')::interval,14,'COMPLETED',now() - ($3 || ' days')::interval,now())`,
      [`${NEAR}-m${m}`, `${NEAR}-a`, String(m * 7)],
    );
  }
  const played: Array<[number, number]> = [
    [1, 0],
    [1, 1],
    [2, 0],
    [2, 1],
    [2, 2],
  ];
  for (const [m, u] of played) {
    await db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,position,"updatedAt") VALUES ($1,$2,$3,'CONFIRMED',$4,now())`, [
      `${NEAR}-at-${m}-${u}`,
      `${NEAR}-m${m}`,
      `${NEAR}-u${u}`,
      u,
    ]);
  }
});

test.afterAll(async ({ db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  resetDb();
});

test("3 miles by default; the radius presets add and drop clubs by distance; hidden clubs never show", async ({ page }) => {
  await signInAs(page, U.admin, PAGE);
  await expect(page.getByRole("heading", { name: "Find clubs near you" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("radio", { name: "Up to 3 miles" })).toHaveAttribute("aria-checked", "true");
  expect(await shown(page)).toEqual([NEAR, PARTNER, DORMANT, THREE]);

  await page.getByRole("radio", { name: "Up to 1 mile" }).click();
  await expect(page).toHaveURL(/radius=1/);
  await expect.poll(() => shown(page)).toEqual([NEAR]);

  await page.getByRole("radio", { name: "Up to 5 miles" }).click();
  await expect.poll(() => shown(page)).toEqual([NEAR, PARTNER, DORMANT, THREE, FIVE]);

  await page.getByRole("radio", { name: "Up to 10 miles" }).click();
  await expect.poll(() => shown(page)).toEqual([NEAR, PARTNER, DORMANT, THREE, FIVE, TEN]);
  await expect(page.getByTestId("find-clubs-count")).toHaveText("6 clubs found");

  // Never more than 10, whatever the URL says.
  await page.goto(`${PAGE}?radius=25`);
  await expect.poll(() => shown(page)).toEqual([NEAR, PARTNER, DORMANT, THREE]);
  for (const never of [FAR, HIDDEN, BLOCKED, DECLINED]) await expect(card(page, never)).toHaveCount(0);
});

test("a card: distance, game, format, members, regular players; no names or numbers on the page", async ({ page }) => {
  await signInAs(page, U.admin, `${PAGE}?radius=5`);
  const near = card(page, NEAR);
  await expect(near).toBeVisible({ timeout: 30_000 });
  await expect(near).toContainText("Near One FC");
  await expect(near).toContainText("Near One FC Pitch, Sutton");
  await expect(near).toContainText("0.8 miles away");
  await expect(near).toContainText("Tuesdays at 19:00, 7-a-side");
  await expect(near).toContainText("3 members");
  await expect(near).toContainText("2 regular players");
  await expect(card(page, FIVE)).toContainText("No regular game yet");
  await expect(card(page, FIVE)).toContainText("4.5 miles away");

  // Already paired: a status, no checkbox.
  await expect(card(page, PARTNER).getByTestId("nearby-club-status")).toHaveText("Already partners");
  await expect(card(page, PARTNER).getByRole("checkbox")).toHaveCount(0);

  const html = await page.content();
  expect(html).not.toContain("Secret Person");
  expect(html).not.toContain("+447700950");
  expect(html).not.toContain("@g.us");
  expect(html).not.toContain(String(north(0.8)).slice(0, 7));
});

test("'Plays on the same day as us': off by default; on, it keeps Tuesday clubs and the club with no game", async ({ page }) => {
  await signInAs(page, U.admin, `${PAGE}?radius=10`);
  const sameDay = page.getByRole("switch", { name: "Plays on the same day as us" });
  await expect(sameDay).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await sameDay.click();
  await expect(page).toHaveURL(/sameDay=1/);
  await expect.poll(() => shown(page)).toEqual([NEAR, FIVE, TEN]);
  await page.getByRole("switch", { name: "Plays on the same day as us" }).click();
  await expect.poll(() => shown(page)).toEqual([NEAR, PARTNER, DORMANT, THREE, FIVE, TEN]);
});

test("tick, select all, the confirm says what they see and what accepting means, then Send", async ({ page }) => {
  await signInAs(page, U.admin, PAGE);
  await expect(card(page, NEAR)).toBeVisible({ timeout: 30_000 });
  const send = page.getByRole("button", { name: "Send request" });
  await expect(send).toBeDisabled();
  await card(page, NEAR).getByRole("checkbox", { name: "Select Near One FC" }).check();
  await expect(page.getByTestId("find-clubs-selected")).toHaveText("1 selected");
  await page.getByRole("checkbox", { name: "Select all" }).check();
  // The partner is not selectable: three of four.
  await expect(page.getByTestId("find-clubs-selected")).toHaveText("3 selected");
  await send.click();
  const confirm = page.getByTestId("find-clubs-confirm");
  await expect(confirm).toContainText("Send a request to 3 clubs?");
  await expect(confirm).toContainText("They will see your club's name, your venue's name and town");
  await expect(confirm).toContainText("Never names or phone numbers.");
  await expect(confirm).toContainText("If a club accepts, you can ask it for players when you're short.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await send.click();
  await page.getByTestId("find-clubs-confirm").getByRole("button", { name: "Send" }).click();
  // The real action (slice P3): each ticked club shows its outcome, and a
  // listed, approved club gets the request.
  await expect(card(page, NEAR).getByTestId("nearby-club-outcome")).toHaveAttribute("data-outcome", "sent", { timeout: 15_000 });
  await expect(card(page, NEAR).getByTestId("nearby-club-outcome")).toHaveText("Request sent");
  await expect(page.getByTestId("find-clubs-error")).toHaveCount(0);
});

test("in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, `${PAGE}?radius=5`);
  await expect(page.getByRole("heading", { name: "Yakınınızdaki kulüpleri bulun" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("radio", { name: "En fazla 5 mil" })).toHaveAttribute("aria-checked", "true");
  const near = card(page, NEAR);
  await expect(near).toContainText("0,8 mil uzakta");
  await expect(near).toContainText("Salı günleri 19:00, 7'ye 7");
  await expect(near).toContainText("3 üye");
  await expect(near).toContainText("2 düzenli oyuncu");
  await expect(card(page, FIVE)).toContainText("Henüz düzenli maçı yok");
  await expect(card(page, PARTNER).getByTestId("nearby-club-status")).toHaveText("Zaten partneriz");
  await expect(page.getByRole("switch", { name: "Bizimle aynı gün oynuyor" })).toBeVisible();
  await expect(page.getByRole("button", { name: "İstek gönder" })).toBeVisible();
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("a club without a venue sees 'Confirm your venue', with a link to the venue lookup", async ({ page, db }) => {
  await db.run(`UPDATE "Activity" SET "venueId" = NULL WHERE id = $1`, [ACTIVITY_ID]);
  await signInAs(page, U.admin, PAGE);
  const prompt = page.getByTestId("find-clubs-no-venue");
  await expect(prompt).toContainText("Confirm your venue to find clubs near you", { timeout: 30_000 });
  await expect(prompt.getByRole("link", { name: "Confirm your venue" })).toHaveAttribute("href", "/admin/settings#club-venue");
  await expect(cards(page)).toHaveCount(0);

  // A club venue alone is enough to search.
  await db.run(`UPDATE "Organisation" SET "homeVenueId" = 'e2e-fc-home' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  await expect.poll(() => shown(page)).toEqual([NEAR, PARTNER, DORMANT, THREE]);
  // Our Tuesday game still counts for the same-day switch.
  await expect(page.getByRole("switch", { name: "Plays on the same day as us" })).toBeVisible();
  // No active game of our own: the switch has nothing to compare, so it goes.
  await db.run(`UPDATE "Activity" SET "isActive" = false WHERE id = $1`, [ACTIVITY_ID]);
  await page.reload();
  await expect.poll(() => shown(page)).toEqual([NEAR, PARTNER, DORMANT, THREE]);
  await expect(page.getByRole("switch", { name: "Plays on the same day as us" })).toHaveCount(0);
  await db.run(`UPDATE "Organisation" SET "homeVenueId" = NULL WHERE id = $1`, [ORG_ID]);
  await db.run(`UPDATE "Activity" SET "venueId" = 'e2e-fc-home', "isActive" = true WHERE id = $1`, [ACTIVITY_ID]);
});

test("'find us' off: the club cannot search (D-3)", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET discoverable = false WHERE id = $1`, [ORG_ID]);
  await signInAs(page, U.admin, PAGE);
  const off = page.getByTestId("find-clubs-off");
  await expect(off).toContainText("Your club can't be found, so it can't search", { timeout: 30_000 });
  await expect(off.getByRole("link", { name: "Open Partner clubs settings" })).toHaveAttribute("href", "/admin/settings#partner-clubs");
  await expect(cards(page)).toHaveCount(0);
  await db.run(`UPDATE "Organisation" SET discoverable = true WHERE id = $1`, [ORG_ID]);
});

test("a PLAYER cannot open the page", async ({ page }) => {
  await signInAs(page, U.player, PAGE);
  await page.waitForLoadState("networkidle");
  expect(new URL(page.url()).pathname).not.toBe(PAGE);
  await expect(page.getByTestId("find-clubs")).toHaveCount(0);
  await expect(page.getByText("Near One FC")).toHaveCount(0);
});
