/**
 * The match page's partner ask, P4 (partner discovery, 2026-10-22). Plan:
 * MDs/partner-discovery-plan-2026-10-21.md, sections 4, 3.4 and 2.1.
 *
 *   - "How many players?" offers 1 (the default) up to the open places;
 *   - a tick per active partner, all ticked by default; a PAUSED partner
 *     (dormant) is shown as paused and has no tick;
 *   - asking 2 partners for 1 player: two asks, ONE round, each for 1;
 *     the round shows its number and how many are found;
 *   - "Cancel this ask" closes the whole round: the group that saw the ask
 *     hears "no longer needed", the one still waiting for approval simply
 *     closes;
 *   - the same panel in Turkish.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const SUTTON = "e2e-xr-web-sutton";
const CHEAM = "e2e-xr-web-cheam";
const PAUSED = "e2e-xr-web-paused";

let placesOpen = 0;

test.beforeAll(async ({ db }) => {
  resetDb();
  const clubs: Array<[string, string, string, string | null]> = [
    [SUTTON, "Sutton Lenders", "120363999000000091@g.us", null],
    [CHEAM, "Cheam Lenders", "120363999000000092@g.us", null],
    [PAUSED, "Sleepy Lenders", "120363999000000093@g.us", "2026-10-01T00:00:00Z"],
  ];
  for (const [id, name, group, dormant] of clubs) {
    await db.run(
      `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","whatsappGroupId","whatsappBotEnabled","dormantAt","createdAt","updatedAt")
       VALUES ($1,$2,$1,$3,'approved',$4,true,$5,now(),now())`,
      [id, name, `${id}-invite`, group, dormant],
    );
  }
  // Sutton lets asks through without asking (posted at once); Cheam checks each ask.
  const pairs: Array<[string, string, string]> = [
    ["e2e-xr-web-p1", SUTTON, "standing"],
    ["e2e-xr-web-p2", CHEAM, "each-ask"],
    ["e2e-xr-web-p3", PAUSED, "standing"],
  ];
  for (const [id, partner, approval] of pairs) {
    await db.run(
      `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"partnerApproval","askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
       VALUES ($1,$2,$3,'active',$4,now(),now(),$5,now(),now())`,
      [id, ORG_ID, partner, approval, U.admin],
    );
  }
  await db.run(`UPDATE "Organisation" SET "partnerAskWhen" = 'on-request' WHERE id = $1`, [ORG_ID]);
  // The seeded game has one place open; three more, so the picker has a range.
  await db.run(`UPDATE "Match" SET "maxPlayers" = "maxPlayers" + 3 WHERE id = $1`, [MATCH.upcoming]);
  const m = await db.one<{ max: number; confirmed: number }>(
    `SELECT m."maxPlayers" AS max, (SELECT count(*)::int FROM "Attendance" a WHERE a."matchId" = m.id AND a.status = 'CONFIRMED') AS confirmed
     FROM "Match" m WHERE m.id = $1`,
    [MATCH.upcoming],
  );
  placesOpen = m!.max - m!.confirmed;
});

test.afterAll(() => {
  resetDb();
});

test("the picker: 1 by default, up to the open places; every active partner ticked; the paused one shown as paused, no tick", async ({ page }) => {
  expect(placesOpen).toBeGreaterThan(1);
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  const panel = page.getByTestId("partner-ask-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const number = panel.getByTestId("partner-ask-number");
  await expect(number).toHaveValue("1");
  await expect(number.locator("option")).toHaveCount(placesOpen);
  await expect(number.locator("option").first()).toHaveText("1 player");
  const ticks = panel.getByTestId("partner-ask-tick");
  await expect(ticks).toHaveCount(2);
  for (const i of [0, 1]) await expect(ticks.nth(i)).toBeChecked();
  await expect(panel.getByTestId("partner-ask-paused")).toHaveText("Sleepy Lenders: paused on MatchTime, so it can't be asked now");
  await expect(panel.locator('[data-testid="partner-ask-row"][data-status="paused"]')).toHaveCount(1);
  await expect(panel.getByTestId("partner-ask-button")).toHaveText("Ask for 1 player");
  // Two ticked: the number is for all of them together.
  await expect(panel).toContainText("The number is for all the clubs you tick together, not for each club.");
  // Unticking one leaves one; the button follows the number.
  await number.selectOption("2");
  await expect(panel.getByTestId("partner-ask-button")).toHaveText("Ask for 2 players");
  await number.selectOption("1");
});

test("asking 2 partners for 1 player: two asks in ONE round, each for 1; nothing for the paused club", async ({ page, db }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  const panel = page.getByTestId("partner-ask-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByTestId("partner-ask-button").click();
  await expect(panel.getByTestId("partner-ask-round")).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.getByTestId("partner-ask-round")).toContainText("Asking for 1 player: 0 found so far");

  const asks = await db.all<{ partnerOrgId: string; places: number; roundId: string | null; status: string }>(
    `SELECT "partnerOrgId", places, "roundId", status FROM "PartnerAsk" WHERE "matchId" = $1 ORDER BY "partnerOrgId"`,
    [MATCH.upcoming],
  );
  expect(asks.map((a) => [a.partnerOrgId, a.places, a.status])).toEqual([
    [CHEAM, 1, "awaiting-approval"],
    [SUTTON, 1, "posted"],
  ]);
  expect(asks[0].roundId).toBeTruthy();
  expect(asks[1].roundId).toBe(asks[0].roundId);
  // The post in Sutton's group asks for ONE player, whatever is open.
  const post = await db.one<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [SUTTON]);
  expect(post?.text).toContain("need 1 player");
  // The paused club: no ask, no notice, no post.
  const paused = await db.one<{ n: number }>(
    `SELECT (SELECT count(*) FROM "PartnerAsk" WHERE "partnerOrgId" = $1)::int + (SELECT count(*) FROM "BotJob" WHERE "orgId" = $1)::int AS n`,
    [PAUSED],
  );
  expect(paused?.n).toBe(0);
});

test("cancel: the whole round closes; the group that saw the ask hears 'no longer needed'; the one waiting for approval simply closes", async ({ page, db }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  const panel = page.getByTestId("partner-ask-panel");
  await expect(panel.getByTestId("partner-ask-round")).toHaveCount(1, { timeout: 30_000 });
  await panel.getByTestId("partner-ask-cancel").click();
  await expect(panel.getByTestId("partner-ask-round")).toHaveCount(0, { timeout: 15_000 });
  // Both partners can be asked again.
  await expect(panel.getByTestId("partner-ask-tick")).toHaveCount(2);

  const asks = await db.all<{ partnerOrgId: string; status: string; reason: string | null }>(
    `SELECT "partnerOrgId", status, reason FROM "PartnerAsk" WHERE "matchId" = $1 ORDER BY "partnerOrgId"`,
    [MATCH.upcoming],
  );
  expect(asks).toEqual([
    { partnerOrgId: CHEAM, status: "cancelled", reason: "organiser-cancelled" },
    { partnerOrgId: SUTTON, status: "cancelled", reason: "organiser-cancelled" },
  ]);
  const lines = await db.all<{ orgId: string; text: string }>(`SELECT "orgId", text FROM "BotJob" WHERE kind = 'group' ORDER BY "createdAt"`);
  expect(lines.filter((l) => l.orgId === SUTTON).map((l) => l.text)).toEqual([
    expect.stringContaining("need 1 player"),
    expect.stringMatching(/no longer need a player, thanks all\.$/),
  ]);
  expect(lines.filter((l) => l.orgId === CHEAM)).toEqual([]);
});

test("Turkish: the picker, the ticks, the paused partner and the round, in Turkish", async ({ page, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
    const panel = page.getByTestId("partner-ask-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText("Kaç oyuncu?");
    await expect(panel).toContainText("Hangi partner kulüpler?");
    await expect(panel.getByTestId("partner-ask-number").locator("option").first()).toHaveText("1 oyuncu");
    await expect(panel.getByTestId("partner-ask-paused")).toHaveText("Sleepy Lenders: MatchTime'da duraklatıldı, şu an sorulamaz");
    await expect(panel.getByTestId("partner-ask-button")).toHaveText("1 oyuncu iste");
    await panel.getByTestId("partner-ask-button").click();
    await expect(panel.getByTestId("partner-ask-round")).toContainText("1 oyuncu isteniyor: şu ana kadar 0 bulundu", { timeout: 15_000 });
    await expect(panel.getByTestId("partner-ask-cancel")).toHaveText("Bu isteği iptal et");
    await panel.getByTestId("partner-ask-cancel").click();
    await expect(panel.getByTestId("partner-ask-round")).toHaveCount(0, { timeout: 15_000 });
    const line = await db.one<{ text: string }>(
      `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' ORDER BY "createdAt" DESC LIMIT 1`,
      [SUTTON],
    );
    // Sutton's own language (English) for its group, whatever the asker's.
    expect(line?.text).toMatch(/no longer need a player, thanks all\.$/);
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});
