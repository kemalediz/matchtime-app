/**
 * POOL SCENARIOS: the limits (slice L5a, 2026-10-24; the rules are L4's).
 * Approved spec, "Limits": at most 2 offers a week and 1 a day per
 * player, none 21:30 to 08:30; 3 ignored offers in a row pause the player;
 * a decline keeps that club away for 14 days. Each is a real conversation
 * through the real routes: what is queued, what the Pi is handed and when,
 * and who hears nothing. Model-free ($0).
 */
import { scenario, scenarios, expect } from "./fixtures";
import { askOf, at, extraMatch, londonOn, near, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer, tapLinkIn, tapOffer } from "./offers-world";

scenarios("the pool's limits", () => {
  scenario("quiet hours: an ask at 21:45 is queued for 08:30 and handed out then, not before", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const late = londonOn(fnf.kickoff, -1, "21:45");
    const morning = londonOn(fnf.kickoff, 0, "08:30");

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: late });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer", sendAfter: morning }]);

    expect((await pollPlatform(pool, { now: londonOn(fnf.kickoff, -1, "23:00") })).out).toEqual([]);
    expect((await pollPlatform(pool, { now: londonOn(fnf.kickoff, 0, "08:29") })).out).toEqual([]);
    const { out } = await pollPlatform(pool, { now: morning });
    expect(out.map((m) => m.to)).toEqual(["ali"]);
    expect((await offersOf(pool, ali))[0].sentAt).toEqual(morning);
  });

  scenario("the autumn clock change night: 21:45 BST on Saturday 24 October waits for 08:30 GMT on Sunday", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", kickoffInHours: Math.max(48, Math.ceil((Date.parse("2026-10-26T19:00:00Z") - Date.now()) / 3600_000)) });
    await poolPlayer(pool, "ali", { at: near(fnf) });
    const saturdayNight = new Date("2026-10-24T20:45:00Z");
    const sundayMorning = new Date("2026-10-25T08:30:00Z");

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: saturdayNight });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer", sendAfter: sundayMorning }]);
    expect((await pollPlatform(pool, { now: new Date("2026-10-25T07:30:00Z") })).out).toEqual([]);
    expect((await pollPlatform(pool, { now: new Date("2026-10-25T08:29:00Z") })).out).toEqual([]);
    expect((await pollPlatform(pool, { now: sundayMorning })).out.map((m) => m.to)).toEqual(["ali"]);
  });

  scenario("one a day across clubs: a second club asking the same day reaches nobody, and he hears nothing more", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const cheam = await openClub(pool, "cheam", { name: "Cheam Lads", venue: near(fnf) });
    await poolPlayer(pool, "ali", { at: near(fnf) });

    const first = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    pool.expectSent(first.sent, [{ to: "ali", purpose: "pool-offer", text: /FNF/ }]);
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });

    const second = await organiserAsks(pool, page, cheam, { places: 1, now: at(fnf.kickoff, -7) });
    expect(second.json.pool).toEqual({ ok: false, refusal: "none-near" });
    pool.expectSent(second.sent, []);
  });

  scenario("two a week across clubs: the third club in seven days reaches nobody", async ({ pool, page }) => {
    const a = await openClub(pool, "a", { name: "Club A", upcomingMatch: { daysFromNow: 2 } });
    const b = await openClub(pool, "b", { name: "Club B", venue: near(a), upcomingMatch: { daysFromNow: 4 } });
    const c = await openClub(pool, "c", { name: "Club C", venue: near(a), upcomingMatch: { daysFromNow: 6 } });
    const ali = await poolPlayer(pool, "ali", { at: near(a) });

    for (const club of [a, b]) {
      const ex = await organiserAsks(pool, page, club, { places: 1, now: at(club.kickoff, -8) });
      pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer" }]);
      await pollPlatform(pool, { now: at(club.kickoff, -8) });
    }
    const third = await organiserAsks(pool, page, c, { places: 1, now: at(c.kickoff, -8) });
    expect(third.json.pool).toEqual({ ok: false, refusal: "none-near" });
    pool.expectSent(third.sent, []);
    expect(await offersOf(pool, ali)).toHaveLength(2);
  });

  scenario("a decline keeps that club away for 14 days; another club may still ask", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const next = await extraMatch(pool, fnf, 72);
    const cheam = await openClub(pool, "cheam", { name: "Cheam Lads", venue: near(fnf), upcomingMatch: { daysFromNow: 5 } });
    await poolPlayer(pool, "ali", { at: near(fnf) });

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    expect(await tapOffer(page, tapLinkIn(ex.sent[0]), "no")).toBe("declined");

    const again = await organiserAsks(pool, page, fnf, { places: 1, now: at(next.kickoff, -8), matchId: next.id });
    expect(again.json.pool).toEqual({ ok: false, refusal: "none-near" });
    pool.expectSent(again.sent, []);

    const other = await organiserAsks(pool, page, cheam, { places: 1, now: at(cheam.kickoff, -8) });
    pool.expectSent(other.sent, [{ to: "ali", purpose: "pool-offer", text: /Cheam Lads/ }]);
  });

  scenario("three offers ignored in a row pause him, with ONE message and the link to want more", async ({ pool, page }) => {
    const a = await openClub(pool, "a", { name: "Club A", upcomingMatch: { daysFromNow: 2 } });
    const b = await openClub(pool, "b", { name: "Club B", venue: near(a), upcomingMatch: { daysFromNow: 5 } });
    const c = await openClub(pool, "c", { name: "Club C", venue: near(a), upcomingMatch: { daysFromNow: 10 } });
    const ali = await poolPlayer(pool, "ali", { at: near(a) });

    for (const [i, club] of [a, b, c].entries()) {
      const askAt = londonOn(club.kickoff, -1, "13:00");
      const ex = await organiserAsks(pool, page, club, { places: 1, now: askAt });
      pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer" }]);
      await pollPlatform(pool, { now: askAt });
      pool.note(`he does not answer; six hours pass (offer ${i + 1})`);
      const { queued } = await pollPlatform(pool, { now: londonOn(club.kickoff, -1, "19:30") });
      if (i < 2) pool.expectSent(queued, []);
      else pool.expectSent(queued, [{ to: "ali", purpose: "pool-paused", text: /the last 3 went unanswered\. Want them again\? Tap here: https?:\/\/\S+\/r\// }]);
    }
    expect((await offersOf(pool, ali)).map((o) => o.outcome)).toEqual(["ignored", "ignored", "ignored"]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "paused", pausedReason: "ignored" });
    expect(await askOf(pool, c)).toMatchObject({ status: "open" });
  });
});
