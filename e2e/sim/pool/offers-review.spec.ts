/**
 * POOL SCENARIOS from the adversarial review of PR #400 (slice L5a,
 * 2026-10-24). Each is the conversation that showed the problem, with the
 * fixed behaviour. Real routes, real database, a real browser for the
 * offer page. Model-free ($0).
 *
 *   M1   a former ADMIN who left comes back as a pool guest: a PLAYER.
 *   M2   a forwarded offer link: the friend sees the game's facts only (no
 *        distance) and cannot answer; five wrong digits lock them; he
 *        himself (signed in) still can.
 *   M3   an offer the Pi held back (its DM pacing) and never sent: when the
 *        round fills it ends `cancelled`, counts for nothing (another club
 *        may offer him the same day), and no "that place has gone" line
 *        ever refers to it.
 *   m1   a club member's plain question is never swallowed by the pool
 *        line; quoting the offer gets it.
 *   m2   the switch off after delivery: his page says the game is off for him.
 *   m4   two sweeps racing for the second wave: it goes once, never past 8.
 *   m6   already this club's guest for another game: "busy", nothing written.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { signInAs } from "../../fixtures";
import {
  askOf,
  at,
  extraMatch,
  holderDigits,
  near,
  offersOf,
  openClub,
  organiserAsks,
  pollPlatform,
  poolPlayer,
  poolSwitchCookie,
  proveOffer,
  tapLinkIn,
  tapOffer,
} from "./offers-world";

scenarios("review of #400: the fixes", () => {
  scenario("M1: a former ADMIN of the club who left takes a pool place: his row is a PLAYER guest, never an organiser", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    await pool.db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "leftAt") VALUES ($1, $2, $3, 'ADMIN', $4)`, [
      `mem-old-${ali.userId}`,
      ali.userId,
      fnf.group.orgId,
      new Date("2026-09-01T12:00:00Z"),
    ]);
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer" }]);
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    await page.context().clearCookies();

    expect(await tapOffer(pool, page, tapLinkIn(ex.sent[0]), "yes")).toBe("in");
    expect(await pool.db.one(`SELECT role, "guestVia", "leftAt" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [ali.userId, fnf.group.orgId])).toEqual({
      role: "PLAYER",
      guestVia: "pool",
      leftAt: null,
    });
  });

  scenario("M2: a forwarded link shows the game only; the friend cannot answer, five wrong digits lock them, he himself signed in still can", async ({ pool, page, browser }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    const link = tapLinkIn(ex.sent[0]);
    const right = await holderDigits(pool, link);
    const wrong = right === "0000" ? "1111" : "0000";

    pool.note("his friend opens the forwarded link");
    const ctx = await browser.newContext();
    const friend = await ctx.newPage();
    await poolSwitchCookie(friend);
    await friend.goto(link);
    await expect(friend.getByTestId("pool-offer-facts")).toContainText("FNF needs 1 player");
    await expect(friend.getByTestId("pool-offer-facts")).not.toContainText("from you");
    // Only the game: not his offer's state, and no answer to press.
    await expect(friend.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "unproved");
    await expect(friend.getByTestId("pool-offer-state")).toHaveCount(0);
    await expect(friend.getByTestId("pool-offer-yes")).toHaveCount(0);
    for (let i = 0; i < 5; i++) {
      await friend.getByTestId("pool-offer-digits").fill(wrong);
      await friend.getByTestId("pool-offer-confirm").click();
      await expect(friend.getByTestId("pool-offer-verify-wrong")).toBeVisible();
    }
    await friend.getByTestId("pool-offer-digits").fill(right);
    await friend.getByTestId("pool-offer-confirm").click();
    await expect(friend.getByTestId("pool-offer-verify-locked")).toBeVisible();
    await expect(friend.getByTestId("pool-offer-page")).toHaveAttribute("data-state", "unproved");
    await ctx.close();
    expect((await offersOf(pool, ali))[0].outcome).toBeNull();
    expect(await pool.db.count(`SELECT count(*) FROM "Attendance" WHERE "userId" = $1`, [ali.userId])).toBe(0);
    pool.expectSent(await pool.collect(), []);

    pool.note("Ali himself, signed in by his own link, answers");
    await page.context().clearCookies();
    await signInAs(page, ali.userId);
    await poolSwitchCookie(page);
    await page.goto(link);
    await expect(page.getByTestId("pool-offer-digits")).toHaveCount(0);
    await expect(page.getByTestId("pool-offer-facts")).toContainText("from you");
    expect(await tapOffer(pool, page, link, "yes")).toBe("in");
  });

  scenario("M3: an offer the Pi held back is never counted: the round fills, it ends cancelled, another club offers him the same day, no 'gone' line", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const cheam = await openClub(pool, "cheam", { name: "Cheam Lads", venue: near(fnf) });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    await poolPlayer(pool, "ben", { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: t0 });

    pool.note("the Pi sends Ben's offer and holds Ali's back (one DM a minute)");
    await pool.db.run(`UPDATE "PlatformJob" SET "sendAfter" = $2 WHERE id = $1`, [ex.sent.find((m) => m.to === "ali")!.id, new Date(t0.getTime() + 3600_000)]);
    await pollPlatform(pool, { now: t0 });
    expect((await offersOf(pool, ali))[0].sentAt).toBeNull();
    await page.context().clearCookies();
    expect(await tapOffer(pool, page, tapLinkIn(ex.sent.find((m) => m.to === "ben")!), "yes")).toBe("in");

    expect((await offersOf(pool, ali))[0]).toMatchObject({ outcome: "cancelled", sentAt: null });
    const job = await pool.db.one<{ status: string }>(`SELECT status FROM "PlatformJob" WHERE id = $1`, [ex.sent.find((m) => m.to === "ali")!.id]);
    expect(job?.status).toBe("failed");
    await pool.collect();
    pool.expectSent((await ali.dm("is there a game?")).sent, []);

    const other = await organiserAsks(pool, page, cheam, { places: 1, now: new Date(t0.getTime() + 30 * 60_000) });
    pool.expectSent(other.sent, [{ to: "ali", purpose: "pool-offer", text: /Cheam Lads/ }]);
  });

  scenario("M3: a job released by the Pi's pacing frees the platform room and is sent on the next poll", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);
    await organiserAsks(pool, page, fnf, { places: 1, now: t0 });
    const first = await pollPlatform(pool, { now: t0, report: "release" });
    expect(first.out.filter((m) => m.to === "ali")).toHaveLength(1);
    expect((await offersOf(pool, ali))[0].sentAt).toBeNull();
    const again = await pollPlatform(pool, { now: new Date(t0.getTime() + 60_000) });
    expect(again.out.filter((m) => m.to === "ali")).toHaveLength(1);
    expect((await offersOf(pool, ali))[0].sentAt).toEqual(new Date(t0.getTime() + 60_000));
  });

  scenario("m1: a club member's plain question is never swallowed by the pool line; quoting the offer gets it", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const home = await openClub(pool, "home", { name: "Home FC", venue: near(fnf) });
    const pete = home.member("pete");
    const peteId = (await pool.userOf(pete))!.id;
    const profileId = `sim-pool-p-pete-${Date.now()}`;
    await pool.db.run(
      `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt", language, "displayName", "areaLat", "areaLng", "maxMiles", "updatedAt")
       VALUES ($1, $2, 'active', now(), 1, 'web', 'req', now(), 'en', 'Pete Power', $3, $4, 3, now())`,
      [profileId, peteId, near(fnf).lat, near(fnf).lng],
    );
    await pool.db.run(`INSERT INTO "PoolSport" (id, "profileId", sport, formats) VALUES ($1, $2, 'football', '{}')`, [`${profileId}-s`, profileId]);
    for (const d of [0, 1, 2, 3, 4, 5, 6]) await pool.db.run(`INSERT INTO "PoolAvailability" (id, "profileId", day, "fromMin", "toMin") VALUES ($1, $2, $3, 0, 1440)`, [`${profileId}-a${d}`, profileId, d]);
    // Two days apart from his own club's game, so he is not busy.
    await pool.db.run(`UPDATE "Match" SET date = $2 WHERE id = $1`, [home.group.matchId, new Date(fnf.kickoff.getTime() + 2 * 24 * 3600_000)]);

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    const offer = ex.sent.find((m) => m.to === "home.pete")!;
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    // The reply rule reads the real clock: the offer reached him a minute ago.
    await pool.db.run(`UPDATE "PoolOffer" SET "sentAt" = $2 WHERE "userId" = $1`, [peteId, new Date(Date.now() - 60_000)]);

    const plain = await pete.dm("see you all thursday");
    expect(plain.json.handled).not.toBe("pool-offer-tap-link");
    expect(plain.sent.filter((m) => m.purpose === "pool-reply")).toEqual([]);

    const quoted = await pete.dm("yes I'll come", { quote: { id: `wamid-${offer.id}`, text: offer.text } });
    expect(quoted.json).toMatchObject({ handled: "pool-offer-tap-link" });
    pool.expectSent(quoted.sent, [{ to: "home.pete", purpose: "pool-reply", text: /tap the link/ }]);
  });

  scenario("m2: the switch goes off after the offer reached him: his page says it is off, nothing is written", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    await page.context().clearCookies();
    expect(await proveOffer(pool, page, tapLinkIn(ex.sent[0]), { poolOpen: false })).toBe("off");
    await expect(page.getByTestId("pool-offer-yes")).toHaveCount(0);
    expect(await pool.db.count(`SELECT count(*) FROM "Attendance" WHERE "userId" = $1`, [ali.userId])).toBe(0);
  });

  scenario("m4: two sweeps race for the second wave: it goes once, and the round never passes 8 offers", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    for (let i = 1; i <= 12; i++) await poolPlayer(pool, `p${i}`, { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);
    await organiserAsks(pool, page, fnf, { places: 1, now: t0 });
    await pollPlatform(pool, { now: t0 });
    const later = new Date(t0.getTime() + 31 * 60_000);
    await Promise.all([pollPlatform(pool, { now: later, report: "none" }), pollPlatform(pool, { now: later, report: "none" })]);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1 AND wave = 2`, [fnf.group.orgId])).toBe(4);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1`, [fnf.group.orgId])).toBe(8);
  });

  scenario("m6: already this club's guest for another game: yes says so, nothing is written, the offer stays his to answer later", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true });
    const next = await extraMatch(pool, fnf, 72);
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    await pool.db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "guestVia", "guestMatchId") VALUES ($1, $2, $3, 'PLAYER', 'pool', $4)`, [
      `mem-guest-${ali.userId}`,
      ali.userId,
      fnf.group.orgId,
      fnf.group.matchId,
    ]);
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(next.kickoff, -8), matchId: next.id });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer" }]);
    await pollPlatform(pool, { now: at(next.kickoff, -8) });
    await page.context().clearCookies();

    expect(await proveOffer(pool, page, tapLinkIn(ex.sent[0]))).toBe("busy");
    await expect(page.getByTestId("pool-offer-state")).toContainText("You already have a place with this club for another game");
    await expect(page.getByTestId("pool-offer-yes")).toHaveCount(0);
    expect((await offersOf(pool, ali))[0].outcome).toBeNull();
    expect(await pool.db.one(`SELECT "guestMatchId" FROM "Membership" WHERE id = $1`, [`mem-guest-${ali.userId}`])).toEqual({ guestMatchId: fnf.group.matchId });
    expect(await pool.db.count(`SELECT count(*) FROM "Attendance" WHERE "userId" = $1 AND "matchId" = $2`, [ali.userId, next.id])).toBe(0);
    expect(await askOf(pool, fnf)).toMatchObject({ status: "open" });
  });
});
