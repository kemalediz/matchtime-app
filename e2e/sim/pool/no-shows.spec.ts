/**
 * POOL SCENARIOS: after the game (slice L7, 2026-10-24). A guest's result,
 * the organisers' no-show marker, a late cancel, the no-show pause and its
 * DM, asking a person to look at the pause, and an organiser taking a pool
 * guest off the game. Through the real routes, the real match page and the
 * real offer page. Model-free ($0).
 *
 *   played        nobody marks him: the cron records "played" once the 24
 *                 hours are up (not before), and tells nobody anything.
 *   no-show       the organiser marks him, changes his mind, marks again;
 *                 the cron makes it final; ONE no-show pauses nobody.
 *   pause         a second no-show in his last five games: paused, one DM
 *                 in his language (EN, TR), nothing to the club, no offers.
 *   late cancel   he gives the place back after the cut-off: a miss.
 *   review        he asks a person to look: only the owner hears; the owner
 *                 lifts it and he is told offers are on again.
 *   removed       an organiser takes him off the game: one neutral DM to him.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { E2E } from "../../helpers/env";
import { signInAs } from "../../fixtures";
import { at, extraMatch, near, openClub, organiserAsks, poolPlayer, poolSwitchCookie, tapOffer } from "./offers-world";
import { gameWasPlayed, guestPlaced, markNoShow, ownerDms, pastGuestGame, placeOf, profileState, runCompleteMatches } from "./safety-world";

const H = 3600_000;

scenarios("after the game: played, no-shows and the pause", () => {
  scenario("nobody marks him: played once the 24 hours are up, and nobody is told anything", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);
    const kickoff = await gameWasPlayed(pool, fnf, { hoursAgo: 3 });

    pool.note("the cron runs before the window closes: nothing final yet");
    const early = await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 23 * H) });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "booked", settledAt: null });
    pool.expectSent(early.sent, []);

    pool.note("after 24 hours: played, settled, still silent");
    const late = await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 25 * H) });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "played", resultById: null });
    expect((await placeOf(pool, fnf, ali))?.settledAt).not.toBeNull();
    pool.expectSent(late.sent, []);
    expect(await profileState(pool, ali)).toMatchObject({ status: "active", pausedReason: null });
  });

  scenario("the organiser marks a no-show, changes his mind, marks it again: final after 24 hours, and one no-show pauses nobody", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);
    const kickoff = await gameWasPlayed(pool, fnf, { hoursAgo: 2 });

    await markNoShow(pool, page, fnf, ali);
    const owner = await pool.userOf(fnf.member("owner"));
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "no-show", resultById: owner!.id, settledAt: null });
    await markNoShow(pool, page, fnf, ali, { noShow: false });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "booked", resultById: null });
    await markNoShow(pool, page, fnf, ali);
    pool.expectSent(await pool.collect(), []);

    const r = await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 25 * H) });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "no-show" });
    pool.expectSent(r.sent, []);
    expect(await profileState(pool, ali)).toMatchObject({ status: "active", pausedReason: null });

    pool.note("the window has closed: the page shows the result, no buttons");
    await gameWasPlayed(pool, fnf, { hoursAgo: 25 });
    await page.goto(`/matches/${fnf.group.matchId}`);
    const row = page.getByTestId("guest-result-row");
    await expect(row.getByTestId("guest-result-final")).toHaveText("Didn't turn up");
    await expect(row.getByTestId("guest-no-show")).toHaveCount(0);
  });

  for (const lang of ["en", "tr"] as const) {
    scenario(`a second no-show in his last five games pauses him: one DM in his language (${lang}), nothing to the club, and no more offers`, async ({ pool, page }) => {
      const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
      const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", lang, at: near(fnf) });
      await pastGuestGame(pool, ali, "no-show", 20);
      await pastGuestGame(pool, ali, "played", 10);
      await guestPlaced(pool, page, fnf, ali);
      const kickoff = await gameWasPlayed(pool, fnf, { hoursAgo: 2 });
      await markNoShow(pool, page, fnf, ali);

      // A quiet-hours-proof time: midday London, the day after.
      const r = await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 25 * H) });
      expect(await profileState(pool, ali)).toMatchObject({ status: "paused", pausedReason: "no-shows" });
      pool.expectSent(r.sent.filter((m) => m.to === "ali" || m.to.startsWith("fnf")), [
        {
          to: "ali",
          purpose: "pool-paused",
          text:
            lang === "en"
              ? /^I've paused game offers because you didn't turn up to 2 of your last 5 games\. You can start them again in 30 days, or ask a person to look at it now: https?:\/\/\S+$/
              : /^Son 5 maçının 2 tanesine gelmediğin için maç tekliflerini durdurdum\. 30 gün sonra yeniden başlatabilirsin/,
        },
      ]);
      pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });

      pool.note("a second cron run tells him nothing more");
      pool.expectSent((await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 26 * H) })).sent, []);

      pool.note("the club asks the pool for its next game: Ben is offered it, Ali is not");
      await poolPlayer(pool, "ben", { name: "Ben Other", at: near(fnf) });
      const next = await extraMatch(pool, fnf, 7 * 24);
      const again = await organiserAsks(pool, page, fnf, { places: 1, now: at(next.kickoff, -8), matchId: next.id });
      expect(again.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ben"]);
    });
  }
});

scenarios("asking a person, and being taken off the game", () => {
  scenario("paused for no-shows, he asks a person to look: only the owner is told; the owner lifts it and he hears offers are on again", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await pool.db.run(`UPDATE "PoolProfile" SET status = 'paused', "pausedReason" = 'no-shows', "pausedAt" = now() WHERE "userId" = $1`, [ali.userId]);

    await signInAs(page, ali.userId, "/play/manage");
    await page.goto("/play/manage");
    await expect(page.getByTestId("pool-pause-note")).toHaveAttribute("data-reason", "no-shows");
    await expect(page.getByTestId("pool-pause-note")).toContainText("You can start game offers again from");
    await page.getByTestId("pool-review-ask").click();
    await expect(page.getByTestId("pool-review-asked")).toBeVisible();

    const sent = await pool.collect();
    expect(sent.map((m) => m.purpose)).toEqual(["owner-pool-review"]);
    expect(ownerDms(sent)[0].to).toContain(E2E.APPROVER_PHONE);
    expect(ownerDms(sent)[0].text).toMatch(/^MatchTime pool: a player asked a person to look at his pause\. Please look: https?:\/\/\S+\/admin\/pool\/safety$/);
    pool.expectNoLeaks([...ali.phoneVariants(), "Ali Kaya"], { to: ownerDms(sent).map((m) => m.to) });
    expect((await profileState(pool, ali))?.reviewRequestedAt).not.toBeNull();

    pool.note("he presses it again on another visit: nothing more");
    await page.reload();
    await expect(page.getByTestId("pool-review-asked")).toBeVisible();
    pool.expectSent(await pool.collect(), []);

    pool.note("the owner lifts the pause on the safety page");
    await pool.db.run(`UPDATE "User" SET "isSuperadmin" = true WHERE id = (SELECT "userId" FROM "Membership" WHERE "orgId" = $1 AND role = 'OWNER' LIMIT 1)`, [fnf.group.orgId]);
    const owner = await pool.userOf(fnf.member("owner"));
    await signInAs(page, owner!.id, "/admin/pool/safety");
    await poolSwitchCookie(page);
    await page.goto("/admin/pool/safety");
    const row = page.getByTestId("ps-pause").filter({ hasText: "Ali Kaya" });
    await expect(row.getByTestId("ps-review-asked")).toBeVisible();
    await row.getByTestId("ps-lift").click();
    await expect(page.getByTestId("ps-pause").filter({ hasText: "Ali Kaya" })).toHaveCount(0);
    expect(await profileState(pool, ali)).toMatchObject({ status: "active", pausedReason: null, reviewRequestedAt: null });
    pool.expectSent(await pool.collect(), [{ to: "ali", purpose: "pool-paused", text: /^Game offers are on again\. Your settings: https?:\/\/\S+$/ }]);
  });

  scenario("an organiser takes a pool guest off the game: one neutral DM to him, his place given up in time, never a miss", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", lang: "tr", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);

    const owner = await pool.userOf(fnf.member("owner"));
    await signInAs(page, owner!.id, `/matches/${fnf.group.matchId}`);
    await page.goto(`/matches/${fnf.group.matchId}`);
    page.once("dialog", (d) => void d.accept());
    pool.log({ kind: "in", from: "fnf.owner", channel: "dm", text: "(match page) remove Ali from the squad" });
    await page.getByTestId("attendance-section").locator("li", { hasText: "Ali" }).getByTitle("Remove from squad").click();
    await expect(page.getByTestId("attendance-section").locator("li", { hasText: "Ali" })).toHaveCount(0, { timeout: 20_000 });

    const sent = await pool.collect();
    const toAli = sent.filter((m) => m.to === "ali");
    expect(toAli).toHaveLength(1);
    expect(toAli[0]).toMatchObject({ purpose: "pool-removed" });
    expect(toAli[0].text).toMatch(/^\*FNF\* için .+ maçında plan değişti: o maç için artık oyuncuya ihtiyaçları yok\. Senin bir şey yapmana gerek yok\.$/);
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "withdrawn" });
    const mem = await pool.db.one<{ leftAt: Date | null }>(`SELECT "leftAt" FROM "Membership" WHERE "orgId" = $1 AND "userId" = $2`, [fnf.group.orgId, ali.userId]);
    expect(mem?.leftAt).not.toBeNull();
  });
});

scenarios("a late cancel", () => {
  scenario("he gives the place back after the club's cut-off: late cancel, the cron leaves it, and it shows as a miss", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const link = await guestPlaced(pool, page, fnf, ali);
    pool.note("the game moves to an hour from now, inside the 4-hour cut-off");
    const kickoff = new Date(Date.now() + H);
    await pool.db.run(`UPDATE "Match" SET date = $2 WHERE id = $1`, [fnf.group.matchId, kickoff]);
    expect(await tapOffer(pool, page, link, "pull-out")).toBe("withdrawn");
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "late-cancel" });

    await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 25 * H) });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "late-cancel" });
    expect((await placeOf(pool, fnf, ali))?.settledAt).not.toBeNull();

    const owner = await pool.userOf(fnf.member("owner"));
    await signInAs(page, owner!.id, "/admin/guests?tab=history");
    await page.goto("/admin/guests?tab=history");
    await expect(page.getByTestId("guest-history-game")).toHaveAttribute("data-result", "late-cancel");
    await expect(page.getByTestId("guest-record")).toHaveText("Turned up to 0 of 1 game");
  });
});
