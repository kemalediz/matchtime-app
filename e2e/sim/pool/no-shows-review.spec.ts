/**
 * POOL SCENARIOS from the adversarial review of #404 (slice L7). Model-free ($0).
 *
 *   1  an undone no-show never counted: a mistake corrected in the window
 *      leaves him active even with an earlier no-show on his record.
 *   2  a game cancelled, then put back on before kickoff: played as any
 *      other (nothing was settled while it was off).
 *   4  deleting his profile and signing up again does not lift a no-show
 *      pause: he comes back paused.
 *   6  taken off the game AFTER kickoff: no "plans changed" DM, nothing
 *      marked, and he stays on the panel for the organisers to mark.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { signInAs } from "../../fixtures";
import { near, openClub, poolPlayer } from "./offers-world";
import { gameWasPlayed, guestPlaced, markNoShow, pastGuestGame, placeOf, profileState, runCompleteMatches } from "./safety-world";

const H = 3600_000;

scenarios("review of #404", () => {
  scenario("an earlier no-show, then one marked and undone inside the window: never counted, he stays active", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await pastGuestGame(pool, ali, "no-show", 20);
    await guestPlaced(pool, page, fnf, ali);
    const kickoff = await gameWasPlayed(pool, fnf, { hoursAgo: 2 });
    await markNoShow(pool, page, fnf, ali);
    pool.note("a cron run inside the window: the marked no-show is not final, nobody is paused");
    pool.expectSent((await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 3 * H) })).sent, []);
    expect(await profileState(pool, ali)).toMatchObject({ status: "active" });
    await markNoShow(pool, page, fnf, ali, { noShow: false });
    const r = await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 25 * H) });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "played" });
    expect(await profileState(pool, ali)).toMatchObject({ status: "active", pausedReason: null });
    pool.expectSent(r.sent, []);
  });

  scenario("a game cancelled and put back on before kickoff: nothing settled while it was off, then played", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);
    await pool.db.run(`UPDATE "Match" SET status = 'CANCELLED' WHERE id = $1`, [fnf.group.matchId]);
    pool.note("the cron runs while it is off, before kickoff");
    await runCompleteMatches(pool, { now: new Date(fnf.kickoff.getTime() - 5 * H) });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "booked", settledAt: null });
    pool.note("it is back on, and is played");
    await pool.db.run(`UPDATE "Match" SET status = 'UPCOMING' WHERE id = $1`, [fnf.group.matchId]);
    const kickoff = await gameWasPlayed(pool, fnf, { hoursAgo: 2 });
    await markNoShow(pool, page, fnf, ali);
    await markNoShow(pool, page, fnf, ali, { noShow: false });
    await runCompleteMatches(pool, { now: new Date(kickoff.getTime() + 25 * H) });
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "played" });
  });

  scenario("paused for no-shows, he deletes his profile and signs up again: he comes back paused", async ({ pool, page }) => {
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: { lat: 51.36, lng: -0.19 } });
    await pastGuestGame(pool, ali, "no-show", 12);
    await pastGuestGame(pool, ali, "no-show", 5);
    await pool.db.run(`UPDATE "PoolProfile" SET status = 'paused', "pausedReason" = 'no-shows', "pausedAt" = now() - interval '4 days' WHERE "userId" = $1`, [ali.userId]);

    await signInAs(page, ali.userId, "/play/manage");
    await page.goto("/play/manage");
    await page.getByRole("button", { name: "Delete my details" }).click();
    await page.getByRole("button", { name: "Yes, delete them" }).click();
    await expect(page.getByRole("status")).toBeVisible({ timeout: 20_000 });
    expect(await profileState(pool, ali)).toBeNull();

    const form = await pool.signUp({ name: "Ali Kaya" }, { poolOpen: true });
    const ex = await ali.dm(form.prefill!);
    expect(ex.json).toMatchObject({ handled: "pool-confirm" });
    expect(await profileState(pool, ali)).toMatchObject({ status: "paused", pausedReason: "no-shows" });
  });

  scenario("taken off the game after kickoff: no DM, nothing marked, and he stays on the panel to be marked", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await guestPlaced(pool, page, fnf, ali);
    await gameWasPlayed(pool, fnf, { hoursAgo: 0.5 });
    await pool.db.run(`UPDATE "Match" SET status = 'TEAMS_PUBLISHED' WHERE id = $1`, [fnf.group.matchId]);

    const owner = await pool.userOf(fnf.member("owner"));
    await signInAs(page, owner!.id, `/matches/${fnf.group.matchId}`);
    await page.goto(`/matches/${fnf.group.matchId}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("attendance-section").locator("li", { hasText: "Ali" }).getByTitle("Remove from squad").click();
    await expect(page.getByTestId("attendance-section").locator("li", { hasText: "Ali" })).toHaveCount(0, { timeout: 20_000 });

    expect((await pool.collect()).filter((m) => m.to === "ali")).toEqual([]);
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "booked" });
    await markNoShow(pool, page, fnf, ali);
    expect(await placeOf(pool, fnf, ali)).toMatchObject({ result: "no-show" });
  });
});
