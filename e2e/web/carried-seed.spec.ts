/**
 * A PLAYER'S SEED CARRIED INTO A NEW CLUB (Kemal, 2026-11-03): "an
 * existing player from other clubs can have the same seed rating when
 * they join a new club".
 *
 * A real join path, end to end: the Pi's `group_join` for a phone that
 * already plays at another club (rated 8, 8 and 9 over three games
 * at a club that shares its players' ratings) creates his membership
 * here with seed 8.333..., never rounded (Kemal, 2026-11-09), and the
 * admin's Seed box on /admin/players shows 8.33. A joiner rated the same
 * at a club with "Share our players' ratings with partner clubs" OFF
 * carries his 8.333... just the same: the seed always
 * carries (Kemal, 2026-11-03). A joiner rated nowhere stays unseeded
 * (NULL) and shows the default 6. The page never names the other clubs.
 *
 * The isolated e2e database, seeded here. No model calls.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const OTHER = "e2e-cs-other"; // shares its players' ratings
const PRIVATE = "e2e-cs-private"; // does not
const CARRIER = { id: "e2e-cs-carrier", name: "Carl Carrier", phone: "447700900971" };
const NEWBIE = { id: "e2e-cs-newbie", name: "Nina Newbie", phone: "447700900972" };
const KEEPER = { id: "e2e-cs-keeper", name: "Kit Keeper", phone: "447700900973" };
const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };

const seedOf = async (db: TestDb, userId: string) =>
  (await db.one<{ seedRating: number | null }>(`SELECT "seedRating" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [userId, ORG_ID]))
    ?.seedRating ?? null;

test.beforeAll(async ({ db }) => {
  resetDb();
  for (const [id, name, share] of [
    [OTHER, "Wednesday Wanderers", true],
    [PRIVATE, "Thursday Keepers", false],
  ] as const) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","sharePlayerRatingsWithPartners","createdAt","updatedAt") VALUES ($1,$2,$1,$3,'approved',$4,now(),now())`,
      [id, name, `${id}-invite`, share],
    );
  }
  for (const u of [CARRIER, NEWBIE, KEEPER]) {
    await db.run(`INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`, [
      u.id,
      u.name,
      `${u.id}@e2e-test.invalid`,
      `+${u.phone}`,
    ]);
  }
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ('e2e-cs-m1',$1,$2,'PLAYER',now())`, [CARRIER.id, OTHER]);
  const day = 24 * 60 * 60 * 1000;
  for (const [org, player] of [
    [OTHER, CARRIER.id],
    [PRIVATE, KEEPER.id],
  ] as const) {
    await db.run(
      `INSERT INTO "Sport" (id,"orgId",name,"playersPerTeam",positions,"teamLabels","updatedAt") VALUES ($1,$2,'Football',5,'{}','{}',now())`,
      [`${org}-sport`, org],
    );
    await db.run(
      `INSERT INTO "Activity" (id,"orgId","sportId",name,"dayOfWeek","time",venue,"updatedAt") VALUES ($1,$2,$3,'Weekly 5s',3,'20:00','Pitch',now())`,
      [`${org}-act`, org, `${org}-sport`],
    );
    for (const [i, score] of [8, 8, 9].entries()) {
      const match = `${org}-match-${i}`;
      const date = new Date(Date.now() - (i + 2) * 7 * day);
      await db.run(
        `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt") VALUES ($1,$2,$3,10,'COMPLETED',$3,now())`,
        [match, `${org}-act`, date],
      );
      await db.run(`INSERT INTO "Rating" (id,"matchId","raterId","playerId",score) VALUES ($1,$2,$3,$4,$5)`, [
        `${match}-r`,
        match,
        U.admin,
        player,
        score,
      ]);
    }
  }
});

test.afterAll(() => {
  resetDb();
});

test("a player rated at another club joins the WhatsApp group: his seed here is his average there, shown in the Seed box", async ({
  page,
  request,
  db,
}) => {
  const res = await request.post("/api/whatsapp/group-join", { headers: KEY, data: { groupId: E2E.GROUP_ID, phones: [CARRIER.phone, NEWBIE.phone, KEEPER.phone] } });
  expect(res.status(), await res.text()).toBe(200);

  // (8 + 8 + 9) / 3, stored exactly: never rounded.
  await expect.poll(async () => Math.abs(((await seedOf(db, CARRIER.id)) ?? 0) - 25 / 3) < 1e-9).toBe(true);
  // Rated nowhere else: left unseeded, read as the default 6.
  expect(await seedOf(db, NEWBIE.id)).toBeNull();
  // Rated the same at a club with sharing OFF: still carries.
  expect(await seedOf(db, KEEPER.id)).toBeCloseTo(25 / 3, 9);
  // His row at the other club is untouched.
  expect((await db.one<{ s: number | null }>(`SELECT "seedRating" AS s FROM "Membership" WHERE id = 'e2e-cs-m1'`))?.s).toBeNull();

  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, U.admin, "/admin/players");
  const carrier = page.getByTestId(`player-row-${CARRIER.id}`);
  await expect(carrier).toBeVisible({ timeout: 30_000 });
  await expect(carrier.locator('input[type="number"]')).toHaveValue("8.33");
  await expect(page.getByTestId(`player-row-${NEWBIE.id}`).locator('input[type="number"]')).toHaveValue("6");
  await expect(page.getByTestId(`player-row-${KEEPER.id}`).locator('input[type="number"]')).toHaveValue("8.33");

  // Leaving the box as it shows writes nothing: the stored 8.333... is
  // not cut to the 8.33 on screen.
  await carrier.locator('input[type="number"]').focus();
  await carrier.locator('input[type="number"]').blur();
  await page.waitForTimeout(800);
  expect(Math.abs(((await seedOf(db, CARRIER.id)) ?? 0) - 25 / 3)).toBeLessThan(1e-9);

  // A plain seed: nothing on the page says where it came from.
  await expect(page.getByText("Wednesday Wanderers")).toHaveCount(0);
  await expect(page.getByText("Thursday Keepers")).toHaveCount(0);
  await expect(page.getByTestId("seed-default-hint").first()).toContainText(
    "A player who joins with ratings at other MatchTime clubs starts at his average there.",
  );
});
