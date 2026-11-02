/**
 * POOL SCENARIOS: the partner pool invite (Kemal, 2026-11-02). A player
 * from a PARTNER club who played in another club's game through a partner
 * ask gets ONE optional DM after it: join the local player pool, by his own
 * signed link, with no WhatsApp code. Model-free ($0): the DM is a sweep on
 * the Pi's platform poll, the join is a page.
 *
 *   picked, the game completed and settled as played: the DM, once
 *   a volunteer who was not picked: nothing
 *   already in the pool (any state, stopped included): nothing
 *   a second partner game: nothing again
 *   his club speaks Turkish: the Turkish DM
 *   a no-show: nothing
 *   joining by the link: the profile, active at once, no code step
 */
import { scenario, scenarios, expect } from "./fixtures";
import { openClub } from "./offers-world";
import { browserOf, pastMatch, piPolls } from "./invites-world";
import type { PoolClub, PoolWorld } from "./world";
import { nextMsgId } from "../group";
import type { SentMessage } from "./transcript";
import { poolPageCopy } from "@/lib/pool/page-copy";

const PLAY = poolPageCopy("en");

/** Quiet hours off, so a run at night still sees the DM go at once. */
async function noQuietHours(pool: PoolWorld, club: PoolClub): Promise<void> {
  await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [club.group.orgId]);
}

/**
 * `memberKey` of `home` volunteered on `asker`'s partner ask for a game that
 * kicked off `hoursAgo` (COMPLETED), as the partner writer and the ask's
 * close leave it: a guest membership, his attendance, his guest place with
 * the ask and its settled result, and the ask's `pickedUserIds` (only when
 * `picked`).
 */
async function partnerPlayed(
  pool: PoolWorld,
  asker: PoolClub,
  home: PoolClub,
  memberKey: string,
  opts: { picked?: boolean; result?: "played" | "no-show"; hoursAgo?: number } = {},
): Promise<{ userId: string; matchId: string }> {
  const game = await pastMatch(pool, asker, opts.hoursAgo ?? 3);
  const userId = (await pool.userOf(home.member(memberKey)))!.id;
  const askId = `sim-xask-${nextMsgId()}`;
  const owner = (await pool.userOf(asker.member("owner")))!.id;
  // One partnership per pair of clubs: made by the first game, reused after.
  await pool.db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'active',now(),now(),$4,now(),now()) ON CONFLICT ("askerOrgId","partnerOrgId") DO NOTHING`,
    [`sim-pair-${nextMsgId()}`, asker.group.orgId, home.group.orgId, owner],
  );
  const pairId = (await pool.db.one<{ id: string }>(`SELECT id FROM "ClubPartnership" WHERE "askerOrgId" = $1 AND "partnerOrgId" = $2`, [asker.group.orgId, home.group.orgId]))!.id;
  await pool.db.run(
    `INSERT INTO "PartnerAsk" (id,"partnershipId","askerOrgId","partnerOrgId","matchId",places,status,"requestedVia","postedAt","postBy","closesAt","closedAt","volunteerUserIds","pickedUserIds","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,1,'filled','button',now(),$6,$6,$6,ARRAY[$7]::text[],$8::text[],now(),now())`,
    [askId, pairId, asker.group.orgId, home.group.orgId, game.id, game.kickoff, userId, opts.picked === false ? [] : [userId]],
  );
  await pool.db.run(
    `INSERT INTO "Membership" (id,"userId","orgId",role,"guestVia","guestFromOrgId","guestMatchId","leftAt") VALUES ($1,$2,$3,'PLAYER','partner',$4,$5,now())
     ON CONFLICT ("userId","orgId") DO UPDATE SET "guestMatchId" = EXCLUDED."guestMatchId"`,
    [`sim-gm-${nextMsgId()}`, userId, asker.group.orgId, home.group.orgId, game.id],
  );
  await pool.db.run(`INSERT INTO "Attendance" (id,"matchId","userId",status,"updatedAt") VALUES ($1,$2,$3,'CONFIRMED',now())`, [`sim-att-${nextMsgId()}`, game.id, userId]);
  await pool.db.run(
    `INSERT INTO "GuestPlace" (id,"orgId","matchId","userId",source,"fromOrgId","partnerAskId",result,"resultAt","settledAt","updatedAt") VALUES ($1,$2,$3,$4,'partner',$5,$6,$7,now(),now(),now())`,
    [`sim-gp-${nextMsgId()}`, asker.group.orgId, game.id, userId, home.group.orgId, askId, opts.result ?? "played"],
  );
  await pool.collect();
  return { userId, matchId: game.id };
}

/** Two clubs: Sutton Football Club asks, FNF's players volunteer. */
async function twoClubs(pool: PoolWorld, homeLang: "en" | "tr" = "en") {
  const sutton = await openClub(pool, "sutton", { name: "Sutton Football Club" });
  const fnf = await openClub(pool, "fnf", { name: "FNF" });
  await noQuietHours(pool, fnf);
  if (homeLang === "tr") await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [fnf.group.orgId]);
  return { sutton, fnf };
}

const linkPath = (m: SentMessage): string => {
  const hit = /https?:\/\/[^\s/]+(\/play\/j\/[A-Za-z0-9_.-]+)$/.exec(m.text);
  if (!hit) throw new Error(`no partner invite link in: ${m.text}`);
  return hit[1];
};

const DM_EN = /^Thanks for playing for \*Sutton Football Club\*\. Want to hear about games near you when your own club isn't playing\? If you'd like to, join the MatchTime player pool here: https?:\/\/\S+\/play\/j\/\S+$/;

scenarios("after a partner game: the pool invite", () => {
  scenario("picked, played: one DM in his club's language, and never again", async ({ pool }) => {
    const { sutton, fnf } = await twoClubs(pool);
    await partnerPlayed(pool, sutton, fnf, "pete");

    const { queued } = await piPolls(pool);
    pool.expectSent(queued, [{ to: "fnf.pete", channel: "dm", purpose: "pool-partner-invite", text: DM_EN }]);
    pool.expectNoLeaks(sutton.secrets(), { to: ["fnf.pete"] });

    pool.note("the next poll sends nothing");
    pool.expectSent((await piPolls(pool)).queued, []);
  });

  scenario("a volunteer who was not picked gets nothing", async ({ pool }) => {
    const { sutton, fnf } = await twoClubs(pool);
    await partnerPlayed(pool, sutton, fnf, "dan", { picked: false });
    pool.expectSent((await piPolls(pool)).queued, []);
  });

  scenario("a no-show gets nothing", async ({ pool }) => {
    const { sutton, fnf } = await twoClubs(pool);
    await partnerPlayed(pool, sutton, fnf, "dan", { result: "no-show" });
    pool.expectSent((await piPolls(pool)).queued, []);
  });

  scenario("already in the pool, active or stopped: nothing", async ({ pool }) => {
    const { sutton, fnf } = await twoClubs(pool);
    for (const [key, status] of [["felix", "active"], ["greg", "stopped"]] as const) {
      const { userId } = await partnerPlayed(pool, sutton, fnf, key);
      await pool.db.run(
        `INSERT INTO "PoolProfile" (id,"userId",status,"stoppedAt","consentAt","consentVersion","consentChannel","consentEvidence","adultConfirmedAt","displayName","areaDistrict","areaLat","areaLng","updatedAt")
         VALUES ($1,$2,$3,$4,now(),1,'web','sim',now(),'X Y','SM1',51.36,-0.19,now())`,
        [`sim-pp-${nextMsgId()}`, userId, status, status === "stopped" ? new Date() : null],
      );
    }
    pool.expectSent((await piPolls(pool)).queued, []);
  });

  scenario("a second partner game does not send it again", async ({ pool }) => {
    const { sutton, fnf } = await twoClubs(pool);
    await partnerPlayed(pool, sutton, fnf, "pete", { hoursAgo: 30 });
    pool.expectSent((await piPolls(pool)).queued, [{ to: "fnf.pete", purpose: "pool-partner-invite", text: DM_EN }]);
    pool.note("he ignores it and plays for Sutton again");
    await partnerPlayed(pool, sutton, fnf, "pete", { hoursAgo: 3 });
    pool.expectSent((await piPolls(pool)).queued, []);
  });

  scenario("his club speaks Turkish: the DM is Turkish", async ({ pool }) => {
    const { sutton, fnf } = await twoClubs(pool, "tr");
    await partnerPlayed(pool, sutton, fnf, "pete");
    pool.expectSent((await piPolls(pool)).queued, [
      { to: "fnf.pete", purpose: "pool-partner-invite", text: /^\*Sutton Football Club\* için oynadığın için teşekkürler\. .* MatchTime oyuncu havuzuna buradan katılabilirsin: \S+\/play\/j\/\S+$/ },
    ]);
  });

  scenario("joining by the link: his profile, active at once, and no WhatsApp code", async ({ pool, browser }) => {
    const { sutton, fnf } = await twoClubs(pool);
    const { userId } = await partnerPlayed(pool, sutton, fnf, "pete");
    const { queued } = await piPolls(pool);
    expect(queued).toHaveLength(1);

    pool.log({ kind: "in", from: "fnf.pete", channel: "dm", text: "(opens his pool link and taps Join)" });
    const page = await browserOf(browser);
    await page.goto(linkPath(queued[0]));
    const card = page.getByTestId("partner-invite");
    await expect(card).toHaveAttribute("data-state", "join", { timeout: 30_000 });
    await expect(page.getByTestId("partner-invite-you")).toContainText("Pete P");
    await expect(page.getByLabel(PLAY.fields.nameLabel, { exact: true })).toHaveValue("Pete P");
    await page.getByRole("checkbox", { name: PLAY.signup.adultLabel }).check();
    await page.getByRole("checkbox", { name: PLAY.signup.consentLabel }).check();
    await page.getByRole("button", { name: PLAY.member.join }).click();
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 30_000 });

    expect(await pool.db.one(`SELECT status, source, "consentChannel", "consentEvidence" LIKE '%:partner-invite' AS marked FROM "PoolProfile" WHERE "userId" = $1`, [userId])).toEqual({
      status: "active",
      source: "profile",
      consentChannel: "web",
      marked: true,
    });
    // No code step: nothing was queued to him (no sign-up code, no welcome).
    pool.expectSent(await pool.collect(), []);
  });
});
