/**
 * Asking a partner club for a player (cross-club ask, slice S2, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.3 to 3.5.
 *
 *   - the match page shows "Ask a partner club" only to an admin of a club
 *     with an ACTIVE partner and asking switched on;
 *   - the button asks the partner's organisers (nothing posted yet);
 *   - the approve page, signed in as the partner's owner, posts the ask
 *     once: a second answer finds it closed;
 *   - nobody but the partner club's owner or admin can answer.
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { MATCH, ORG_ID } from "../helpers/constants";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const PARTNER = "e2e-xask-sutton";
const PARTNER_OWNER = "e2e-xask-owner";
const PAIR = "e2e-xask-pair";

const ask = async (db: TestDb) =>
  db.one<{ id: string; status: string; postJobId: string | null }>(
    `SELECT id, status, "postJobId" FROM "PartnerAsk" WHERE "matchId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [MATCH.upcoming],
  );

test.beforeAll(async () => {
  resetDb();
});

test.afterAll(() => {
  resetDb();
});

test("no active partner: no panel on the match page", async ({ page }) => {
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  await expect(page.getByText("Alex Admin").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("partner-ask-panel")).toHaveCount(0);
});

test("an active partner and asking on: the admin asks, the partner's organisers are asked", async ({ page, db }) => {
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus","whatsappGroupId","whatsappBotEnabled","createdAt","updatedAt")
     VALUES ($1,'Sutton Lenders',$1,$2,'approved','120363999000000071@g.us',true,now(),now())`,
    [PARTNER, `${PARTNER}-invite`],
  );
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt") VALUES ($1,'Sam Lender',$2,'+447700900971',true,true,now())`,
    [PARTNER_OWNER, `${PARTNER_OWNER}@e2e-test.invalid`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role,"createdAt") VALUES ($1,$2,$3,'OWNER',now())`, [
    `${PARTNER_OWNER}-m`,
    PARTNER_OWNER,
    PARTNER,
  ]);
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'active',now(),now(),$4,now(),now())`,
    [PAIR, ORG_ID, PARTNER, U.admin],
  );
  // Asking is Off by default: still no panel.
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  await expect(page.getByText("Alex Admin").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("partner-ask-panel")).toHaveCount(0);

  await db.run(`UPDATE "Organisation" SET "partnerAskWhen" = 'on-request' WHERE id = $1`, [ORG_ID]);
  await page.reload();
  const panel = page.getByTestId("partner-ask-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByTestId("partner-ask-button").click();
  await expect(panel.getByTestId("partner-ask-row")).toHaveAttribute("data-status", "awaiting-approval", { timeout: 15_000 });
  await expect(panel).toContainText("Waiting for Sutton Lenders's organisers to say yes");
  const row = await ask(db);
  expect(row?.status).toBe("awaiting-approval");
  expect(row?.postJobId).toBeNull();
  // The partner's owner was asked by DM (the default channel: one person).
  const dm = await db.one<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' ORDER BY "createdAt" DESC LIMIT 1`, [PARTNER]);
  expect(dm?.text).toContain("ask if one of your players can play for them");
});

test("a player of the asking club does not see the panel", async ({ page }) => {
  await signInAs(page, U.player, `/matches/${MATCH.upcoming}`);
  await expect(page.getByText("Alex Admin").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("partner-ask-panel")).toHaveCount(0);
});

test("someone who is not the partner's organiser cannot answer", async ({ page, db }) => {
  const row = await ask(db);
  await signInAs(page, U.player, `/partner-asks/${row!.id}`);
  await expect(page.getByTestId("partner-ask-page")).toContainText("Only an owner or admin of the club that was asked", { timeout: 30_000 });
  await expect(page.getByTestId("partner-ask-approve")).toHaveCount(0);
});

test("the partner's owner approves once: posted in their group; a second answer finds it closed", async ({ page, db }) => {
  const row = await ask(db);
  await signInAs(page, PARTNER_OWNER, `/partner-asks/${row!.id}`);
  await expect(page.getByTestId("partner-ask-summary")).toContainText("ask if one of your players can play for them", { timeout: 30_000 });
  await page.getByTestId("partner-ask-approve").click();
  // The answer shows, and the page (refreshed by the action) says posted.
  await expect(page.getByText("Posted in your players' group.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("partner-ask-approve")).toHaveCount(0);
  const after = await ask(db);
  expect(after?.status).toBe("posted");
  const post = await db.one<{ text: string; kind: string }>(`SELECT text, kind FROM "BotJob" WHERE id = $1`, [after!.postJobId]);
  expect(post?.kind).toBe("group");
  // 2026-10-21: volunteers answer MatchTime privately, through the post's
  // tap-to-DM link; the post never asks for replies in the group.
  expect(post?.text).toContain("Tap here to tell MatchTime privately: https://wa.me/");
  expect(post?.text).not.toContain("Reply to this message");
  const posts = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group'`, [PARTNER]);
  expect(posts?.n).toBe(1);

  await page.reload();
  await expect(page.getByTestId("partner-ask-closed")).toHaveText("Posted in your players' group.", { timeout: 30_000 });
  await expect(page.getByTestId("partner-ask-approve")).toHaveCount(0);

  // The asking club's match page now shows the ask as posted.
  await signInAs(page, U.admin, `/matches/${MATCH.upcoming}`);
  await expect(page.getByTestId("partner-ask-row")).toHaveAttribute("data-status", "posted", { timeout: 30_000 });
});
