/**
 * POOL SCENARIO: asking again after a cancelled round (2026-10-29). Real
 * routes, real database, model-free ($0):
 *
 *   the organiser asks the pool, then cancels the round before the Pi
 *   sends the offer DMs: those offers never reached anyone (cancelled,
 *   never sent). Asking the pool again for the same game offers the SAME
 *   two players, and their DMs go. An offer that did reach him still
 *   means "one per match" (offers-caps, offers-review).
 */
import { scenario, scenarios, expect } from "./fixtures";
import { at, near, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer } from "./offers-world";

scenarios("asking the pool again after a cancelled round", () => {
  scenario("ask, cancel before the DMs go, ask again: the same two players get their offers", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    const can = await poolPlayer(pool, "can", { name: "Can Demir", at: near(fnf) });

    const first = await organiserAsks(pool, page, fnf, { places: 2, now: at(fnf.kickoff, -8) });
    expect(first.json.pool).toMatchObject({ ok: true, waveSent: true });
    pool.expectSent(first.sent, [
      { to: "ali", purpose: "pool-offer" },
      { to: "can", purpose: "pool-offer" },
    ]);

    pool.note("the organiser cancels the round on the match page before the Pi polls");
    await page.goto(`/matches/${fnf.group.matchId}`);
    const panel = page.getByTestId("partner-ask-panel");
    await expect(panel.getByTestId("partner-ask-round")).toHaveCount(1, { timeout: 30_000 });
    await panel.getByTestId("partner-ask-cancel").click();
    await expect(panel.getByTestId("partner-ask-round")).toHaveCount(0, { timeout: 15_000 });
    for (const p of [ali, can]) {
      expect(await offersOf(pool, p)).toEqual([expect.objectContaining({ outcome: "cancelled", sentAt: null })]);
    }
    const { out: none } = await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    expect(none).toEqual([]);

    pool.note("he asks the pool again for the same game");
    const again = await organiserAsks(pool, page, fnf, { places: 2, now: at(fnf.kickoff, -7) });
    expect(again.json.pool).toMatchObject({ ok: true, waveSent: true });
    pool.expectSent(again.sent, [
      { to: "ali", purpose: "pool-offer" },
      { to: "can", purpose: "pool-offer" },
    ]);
    const { out } = await pollPlatform(pool, { now: at(fnf.kickoff, -7) });
    expect(out.map((m) => m.to).sort()).toEqual(["ali", "can"]);
    for (const p of [ali, can]) {
      const rows = await offersOf(pool, p);
      // Still one row per match per person: the never-reached one, reset.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: null, wave: 1 });
      expect(rows[0].sentAt).not.toBeNull();
    }
  });
});
