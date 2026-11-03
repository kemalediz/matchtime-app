/**
 * "Who is who on your list" on /admin/months (2026-11-03).
 *
 * The organiser's posted list had names that matched nobody, because the
 * club's members were imported from WhatsApp with no name. The months page
 * shows each such name with a picker of the members MatchTime has no name
 * for (by phone, organisers only); his choice puts the member on the draft
 * with that line and names him. A plain player cannot reach it.
 *
 * No model is called anywhere in this spec ($0).
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ACTIVITY_ID, ORG_ID } from "../helpers/constants";
import { testDb } from "../helpers/test-db";
import { londonMonthStart } from "@/lib/squad-month-rules";
import { nextMonthStart } from "@/lib/month-signup-rules";

test.describe.configure({ mode: "serial" });

const NEXT = nextMonthStart(londonMonthStart(new Date()));
const NAMELESS = [
  { id: "e2e-msm-anon1", phone: "+447700934001" },
  { id: "e2e-msm-anon2", phone: "+447700934002" },
];
const PROPOSAL = "e2e-msm-proposal";

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly', "rollingSquadEnabled" = false WHERE id = $1`, [ORG_ID]);
  for (const m of NAMELESS) {
    await db.run(`INSERT INTO "User" (id, email, name, "phoneNumber", "updatedAt") VALUES ($1, $2, NULL, $3, now())`, [m.id, `${m.id}@e2e.test`, m.phone]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER')`, [`mem-${m.id}`, m.id, ORG_ID]);
  }
  // The draft MatchTime read from the organiser's posted list, waiting for
  // his yes: one name it matched, two it could not.
  const seed = {
    activityId: ACTIVITY_ID,
    games: 4,
    rows: [{ userId: U.admin, kind: "regular", tier: "standard", slot: 1, paid: "claimed", paidAmountPence: null, gamesCommitted: null, listName: "Alex" }],
    unmatched: [
      { ref: "u1", name: "Craig", slot: 2, kind: "regular", tier: "standard", paid: "claimed", paidAmountPence: null, gamesCommitted: 4, candidates: [] },
      { ref: "u2", name: "Ben", slot: 3, kind: "payg", tier: "standard", paid: "none", paidAmountPence: null, gamesCommitted: null, candidates: [] },
    ],
  };
  await db.run(
    `INSERT INTO "AdminSquadProposal" (id, "orgId", "matchId", "waMessageId", "proposedByUserId", "playingUserIds", "monthStart", "monthSeed", "expiresAt")
     VALUES ($1, $2, '', $3, $4, $5, $6, $7::jsonb, now() + interval '1 day')`,
    [PROPOSAL, ORG_ID, `wa-${PROPOSAL}`, U.admin, [U.admin], NEXT, JSON.stringify(seed)],
  );
});
test.afterAll(() => resetDb());

test("each name the list could not match has a picker of the nameless members by phone; a choice puts him on the draft and names him", async ({ page, db }) => {
  await signInAs(page, U.admin, "/admin/months");
  const card = page.getByTestId("seed-match-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("seed-match-name")).toHaveText(["Craig", "Ben"]);
  const craig = card.locator('[data-testid="seed-match-row"][data-ref="u1"]');
  const options = await craig.getByTestId("seed-match-pick").locator("option").allTextContents();
  expect(options).toEqual(["Choose a member", "+44 7700 934001", "+44 7700 934002"]);

  await craig.getByTestId("seed-match-pick").selectOption(NAMELESS[0].id);
  await craig.getByTestId("seed-match-save").click();
  // Craig is matched: only Ben is left, and the member is no longer offered.
  await expect(card.getByTestId("seed-match-name")).toHaveText(["Ben"], { timeout: 15_000 });
  const ben = card.locator('[data-testid="seed-match-row"][data-ref="u2"]');
  expect(await ben.getByTestId("seed-match-pick").locator("option").allTextContents()).toEqual(["Choose a member", "+44 7700 934002"]);

  const p = await db.one<{ monthSeed: { rows: Array<Record<string, unknown>>; unmatched: Array<{ ref: string }> }; playingUserIds: string[] }>(
    `SELECT "monthSeed", "playingUserIds" FROM "AdminSquadProposal" WHERE id = $1`,
    [PROPOSAL],
  );
  expect(p?.monthSeed.rows).toContainEqual(expect.objectContaining({ userId: NAMELESS[0].id, listName: "Craig", gamesCommitted: 4, paid: "claimed", slot: 2 }));
  expect(p?.monthSeed.unmatched.map((u) => u.ref)).toEqual(["u2"]);
  expect(p?.playingUserIds).toEqual([U.admin, NAMELESS[0].id]);
  expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [NAMELESS[0].id]))?.name).toBe("Craig");
  expect(await db.count(`SELECT COUNT(*) FROM "UserAlias" WHERE "orgId" = $1 AND "userId" = $2 AND alias = 'craig'`, [ORG_ID, NAMELESS[0].id])).toBe(1);
  // Nothing sent anywhere.
  expect(await db.count(`SELECT COUNT(*) FROM "BotJob"`)).toBe(0);

  // The last one matched: the card is gone.
  await ben.getByTestId("seed-match-pick").selectOption(NAMELESS[1].id);
  await ben.getByTestId("seed-match-save").click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});

test("a player cannot reach it", async ({ page }) => {
  await signInAs(page, U.player, "/admin/months");
  await expect(page.getByTestId("seed-match-card")).toHaveCount(0);
});
