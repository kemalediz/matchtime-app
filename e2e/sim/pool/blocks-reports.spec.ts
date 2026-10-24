/**
 * POOL SCENARIOS: blocks and reports (slice L7, 2026-10-24). Through the
 * real guest card, manage page and offer page; what MatchTime queued, to
 * whom, and what the database holds. Model-free ($0).
 *
 *   organiser blocks a guest   no more offers from that club, another club
 *                              still offers; he is never told.
 *   player blocks a club       from his manage page, and from the offer
 *                              page; the club is never told.
 *   reports, each side         reach ONLY the platform owner (one DM a
 *                              player a day, no text, no name), never the
 *                              other side; two clubs' reports pause him.
 *   Turkish                    the card's controls in the club's language.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { E2E } from "../../helpers/env";
import { signInAs } from "../../fixtures";
import { at, extraMatch, near, openClub, organiserAsks, pollPlatform, poolPlayer, poolSwitchCookie, proveOffer, tapLinkIn } from "./offers-world";
import { guestPlaced, openGuestCard, ownerDms, profileState } from "./safety-world";

scenarios("blocks", () => {
  scenario("the organiser stops offering his club's games to a guest: no offers from that club again, another club still offers, and he is never told", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const gs = await openClub(pool, "gs", { name: "Galata FC", hq: true, venue: near(fnf) });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf), maxMiles: 10 });
    await guestPlaced(pool, page, fnf, ali);

    await openGuestCard(pool, page, fnf, ali);
    pool.log({ kind: "in", from: "fnf.owner", channel: "dm", text: "(guest card) don't offer Ali our games again" });
    await page.getByTestId("guest-block").click();
    await expect(page.getByTestId("guest-blocked")).toHaveText("Not offered your games any more");
    await expect(page.getByTestId("guest-block")).toHaveAttribute("data-blocked", "yes");
    expect(await pool.db.count(`SELECT count(*) FROM "PoolBlock" WHERE "orgId" = $1 AND "userId" = $2 AND by = 'club'`, [fnf.group.orgId, ali.userId])).toBe(1);
    pool.expectSent(await pool.collect(), []);

    pool.note("FNF's next game: not offered to Ali");
    const next = await extraMatch(pool, fnf, 7 * 24);
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(next.kickoff, -8), matchId: next.id });
    expect(ex.sent.filter((m) => m.to === "ali")).toEqual([]);

    pool.note("Galata FC's game three days later (his caps allow one offer a day): still offered to Ali");
    const gsGame = await extraMatch(pool, gs, 72);
    const gx = await organiserAsks(pool, page, gs, { places: 1, now: at(gsGame.kickoff, -8), matchId: gsGame.id });
    expect(gx.sent.filter((m) => m.to === "ali").map((m) => m.purpose)).toEqual(["pool-offer"]);
    pool.expectNoLeaks(["block", "Not offered"], { to: ["ali"] });
  });

  scenario("he stops a club's offers from his manage page: no offers from it again, and the club is never told", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);

    await signInAs(page, ali.userId, "/play/manage");
    await page.goto("/play/manage");
    const row = page.getByTestId("pool-club-row").filter({ hasText: "FNF" });
    pool.log({ kind: "in", from: "ali", channel: "dm", text: "(manage page) stop FNF's offers" });
    await row.getByTestId("pool-club-block").click();
    await expect(row).toHaveAttribute("data-blocked", "yes");
    expect(await pool.db.count(`SELECT count(*) FROM "PoolBlock" WHERE "orgId" = $1 AND "userId" = $2 AND by = 'player'`, [fnf.group.orgId, ali.userId])).toBe(1);
    pool.expectSent(await pool.collect(), []);

    const next = await extraMatch(pool, fnf, 7 * 24);
    // The organiser's own session again on this browser (the cache in
    // organiserAsks still thinks it is his).
    await signInAs(page, (await pool.userOf(fnf.member("owner")))!.id);
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(next.kickoff, -8), matchId: next.id });
    expect(ex.sent.filter((m) => m.to === "ali")).toEqual([]);
    expect(ex.sent.filter((m) => m.to.startsWith("fnf"))).toEqual([]);
  });

  scenario("he stops the club's offers from the offer page itself (Turkish): done, and the club hears nothing", async ({ pool, page }) => {
    const gs = await openClub(pool, "gs", { name: "Galata FC", hq: true });
    const can = await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(gs) });
    const ex = await organiserAsks(pool, page, gs, { places: 1, now: at(gs.kickoff, -8) });
    await pollPlatform(pool, { now: at(gs.kickoff, -8) });
    const link = tapLinkIn(ex.sent.find((m) => m.to === "can")!);

    expect(await proveOffer(pool, page, link)).toBe("open");
    await expect(page.getByTestId("pool-offer-block")).toHaveText("Galata FC maçlarını bana önerme");
    await page.getByTestId("pool-offer-block").click();
    await expect(page.getByTestId("pool-offer-blocked")).toHaveText("Tamam. Galata FC tekliflerini bir daha almayacaksın.");
    expect(await pool.db.count(`SELECT count(*) FROM "PoolBlock" WHERE "orgId" = $1 AND "userId" = $2 AND by = 'player'`, [gs.group.orgId, can.userId])).toBe(1);
    pool.expectSent(await pool.collect(), []);
  });

  scenario("a forwarded offer link cannot block or report for him: the page shows no such buttons until his digits are proved", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    await poolSwitchCookie(page);
    await page.goto(tapLinkIn(ex.sent.find((m) => m.to === "ali")!));
    await expect(page.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "unproved");
    await expect(page.getByTestId("pool-offer-safety")).toHaveCount(0);
  });
});

scenarios("reports reach only the platform owner", () => {
  scenario("a club reports a guest: one owner DM with no text and no name, nothing to the guest or the group; a second report that day adds no DM", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);

    await openGuestCard(pool, page, fnf, ali);
    await page.getByTestId("guest-report-open").click();
    await page.getByTestId("guest-report-text").fill("He shouted at our goalkeeper and left at half time.");
    pool.log({ kind: "in", from: "fnf.owner", channel: "dm", text: "(guest card) report a problem" });
    await page.getByTestId("guest-report-send").click();
    await expect(page.getByTestId("guest-report-sent")).toHaveText("Thanks. The MatchTime team will look at it.");

    const sent = await pool.collect();
    expect(sent.map((m) => m.purpose)).toEqual(["owner-pool-report"]);
    expect(ownerDms(sent)[0].text).toMatch(/^MatchTime pool: a club reported a problem with a guest\. Please look: https?:\/\/\S+\/admin\/pool\/safety$/);
    expect(ownerDms(sent)[0].to).toContain(E2E.APPROVER_PHONE);
    pool.expectNoLeaks(["shouted", "Ali", ...ali.phoneVariants()], { in: sent });
    const report = await pool.db.one<{ by: string; text: string; matchId: string | null }>(`SELECT by, text, "matchId" FROM "PoolReport" WHERE "userId" = $1`, [ali.userId]);
    expect(report).toEqual({ by: "club", text: "He shouted at our goalkeeper and left at half time.", matchId: fnf.group.matchId });

    pool.note("another organiser reports again the same day: recorded, no second owner DM");
    await page.reload();
    await page.getByTestId("attendance-section").locator("li", { hasText: "Ali" }).getByTestId("guest-card-open").first().click();
    await page.getByTestId("guest-report-open").click();
    await page.getByTestId("guest-report-text").fill("Also late.");
    await page.getByTestId("guest-report-send").click();
    await expect(page.getByTestId("guest-report-sent")).toBeVisible();
    pool.expectSent(await pool.collect(), []);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolReport" WHERE "userId" = $1`, [ali.userId])).toBe(2);
    expect(await profileState(pool, ali)).toMatchObject({ status: "active" });
  });

  scenario("a player reports a club from his manage page: only the owner hears, the club is never told", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);

    await signInAs(page, ali.userId, "/play/manage");
    await page.goto("/play/manage");
    const row = page.getByTestId("pool-club-row").filter({ hasText: "FNF" });
    await row.getByTestId("pool-club-report-open").click();
    await row.getByTestId("pool-club-report-text").fill("Nobody was at the venue when I arrived.");
    await row.getByTestId("pool-club-report-send").click();
    await expect(row.getByTestId("pool-club-report-sent")).toBeVisible();

    const sent = await pool.collect();
    expect(sent.map((m) => m.purpose)).toEqual(["owner-pool-report"]);
    expect(ownerDms(sent)[0].text).toMatch(/^MatchTime pool: a player reported a problem with a club\. Please look:/);
    expect(sent.filter((m) => m.to.startsWith("fnf"))).toEqual([]);
    expect(await pool.db.one(`SELECT by, "orgId" FROM "PoolReport" WHERE "userId" = $1`, [ali.userId])).toEqual({ by: "player", orgId: fnf.group.orgId });
  });

  scenario("a player reports a club from the offer page: only the owner hears", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    expect(await proveOffer(pool, page, tapLinkIn(ex.sent.find((m) => m.to === "ali")!))).toBe("open");
    await page.getByTestId("pool-offer-report-open").click();
    await page.getByTestId("pool-offer-report-text").fill("ok");
    await page.getByTestId("pool-offer-report-send").click();
    await expect(page.getByTestId("pool-offer-report-error")).toHaveText("Please say a little more about what happened.");
    await page.getByTestId("pool-offer-report-text").fill("The organiser messaged me asking for money upfront.");
    await page.getByTestId("pool-offer-report-send").click();
    await expect(page.getByTestId("pool-offer-report-sent")).toBeVisible();
    const sent = await pool.collect();
    expect(sent.map((m) => m.purpose)).toEqual(["owner-pool-report"]);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolReport" WHERE "userId" = $1 AND by = 'player'`, [ali.userId])).toBe(1);
  });

  scenario("open reports from two different clubs pause him pending a person's review: one neutral DM to him, the clubs hear nothing", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const gs = await openClub(pool, "gs", { name: "Galata FC", hq: true, venue: near(fnf) });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf), maxMiles: 10 });
    await guestPlaced(pool, page, fnf, ali);
    // Three days later (one offer a day): his second guest game, at Galata FC.
    const gsGame = await extraMatch(pool, gs, 72);
    await guestPlaced(pool, page, gs, ali, { matchId: gsGame.id, kickoff: gsGame.kickoff });

    for (const [club, matchId] of [
      [fnf, undefined],
      [gs, gsGame.id],
    ] as const) {
      await openGuestCard(pool, page, club, ali, matchId);
      await page.getByTestId("guest-report-open").click();
      await page.getByTestId("guest-report-text").fill(`Trouble at ${club.name}'s game.`);
      await page.getByTestId("guest-report-send").click();
      await expect(page.getByTestId("guest-report-sent")).toBeVisible();
    }
    expect(await profileState(pool, ali)).toMatchObject({ status: "paused", pausedReason: "reports" });
    const sent = await pool.collect();
    pool.expectSent(sent.filter((m) => !m.purpose?.startsWith("owner-")), [
      { to: "ali", purpose: "pool-paused", text: /^I've paused game offers while the MatchTime team looks at your profile\. You can ask about it here: https?:\/\/\S+$/ },
    ]);
    // One owner DM per player per day, however many reports.
    expect(ownerDms(sent)).toHaveLength(1);
    // His pause line names no club and no report.
    pool.expectNoLeaks(["FNF", "Galata", "Trouble", "report"], { in: sent, to: ["ali"] });
  });
});

scenarios("in Turkish", () => {
  scenario("the guest card's block and report controls speak the club's language", async ({ pool, page }) => {
    const gs = await openClub(pool, "gs", { name: "Galata FC", hq: true });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [gs.group.orgId]);
    const can = await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(gs) });
    await guestPlaced(pool, page, gs, can);
    await openGuestCard(pool, page, gs, can);
    await expect(page.getByTestId("guest-block")).toHaveText("Bu oyuncuya maçlarımızı bir daha önerme");
    await expect(page.getByTestId("guest-report-open")).toHaveText("Bir sorunu bildir");
  });
});
