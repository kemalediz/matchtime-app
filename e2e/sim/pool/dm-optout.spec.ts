/**
 * POOL SCENARIOS: the general DM opt-out ("stop", "stop messaging me",
 * "mesaj atma") and the pool (decisions L6.10 and L6.11, the manager,
 * 2026-10-24: a person who opts out of MatchTime DMs has withdrawn consent).
 * Deterministic, no model ($0).
 *
 *   a pool-only player says "stop": his pool profile stops (the manage
 *   page's Stop, recorded from his message), one pool line, no more offers;
 *   in Turkish too;
 *   a club member with a pool profile says "stop": his club's opt-out reply
 *   as before, and his pool profile stops (no second line);
 *   someone who opted out BEFORE joining the pool: an offer to him is
 *   cancelled at dispatch, never sent; a fresh "start again" consent after
 *   the opt-out is his newer word.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { at, near, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer } from "./offers-world";
import type { PoolClub, PoolWorld } from "./world";

async function consentRecord(pool: PoolWorld, userId: string) {
  return pool.db.one<{ action: string; channel: string; evidence: string }>(
    `SELECT action, channel, evidence FROM "PoolConsentRecord" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [userId],
  );
}

/** A club member who also joined the pool (L3's opt-in), near `club`. */
async function memberInPool(pool: PoolWorld, home: PoolClub, key: string, near: { lat: number; lng: number }) {
  const m = home.member(key);
  const userId = (await pool.userOf(m))!.id;
  const profileId = `sim-pool-p-${key}-${Date.now()}`;
  await pool.db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt", language, "displayName", "areaLat", "areaLng", "maxMiles", "updatedAt")
     VALUES ($1, $2, 'active', $3, 1, 'web', 'req', $3, 'en', $4, $5, $6, 3, $3)`,
    [profileId, userId, new Date(Date.now() - 20 * 24 * 3600_000), m.name ?? key, near.lat, near.lng],
  );
  await pool.db.run(`INSERT INTO "PoolSport" (id, "profileId", sport, formats) VALUES ($1, $2, 'football', '{}')`, [`${profileId}-s`, profileId]);
  for (const d of [0, 1, 2, 3, 4, 5, 6]) await pool.db.run(`INSERT INTO "PoolAvailability" (id, "profileId", day, "fromMin", "toMin") VALUES ($1, $2, $3, 0, 1440)`, [`${profileId}-a${d}`, profileId, d]);
  return Object.assign(m, { userId });
}

scenarios("the general DM opt-out and the pool", () => {
  scenario("a pool-only player says 'stop': pool offers stopped, recorded from his message, one line; the next ask passes him by", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });

    const ex = await ali.dm("stop");
    expect(ex.json).toMatchObject({ handled: "dm-subscription", cmd: "opt-out-all", poolStopped: true });
    pool.expectSent(ex.sent, [{ to: "ali", channel: "dm", purpose: "pool-reply", text: /^Done, I've stopped game offers\. You can start them again here: https?:\/\/\S+\/r\/\S+$/ }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "stopped" });
    expect(await consentRecord(pool, ali.userId)).toEqual({ action: "withdraw", channel: "whatsapp", evidence: `whatsapp:${ex.messageId}:stop` });

    pool.note("'stop' again: nothing more");
    pool.expectSent((await ali.dm("stop")).sent, []);

    const ask = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ask.json.pool).toEqual({ ok: false, refusal: "none-near" });
    expect(await offersOf(pool, ali)).toEqual([]);
  });

  scenario("in Turkish: 'mesaj atma' from a Turkish pool player stops his offers, one Turkish line", async ({ pool }) => {
    const gs = await openClub(pool, "gs", { name: "Galata FC" });
    const can = await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(gs) });
    const ex = await can.dm("mesaj atma");
    expect(ex.json).toMatchObject({ handled: "dm-subscription", poolStopped: true });
    pool.expectSent(ex.sent, [{ to: "can", purpose: "pool-reply", text: /^Tamam, maç tekliflerini durdurdum\. Yeniden başlatmak için: / }]);
    expect(await pool.profileOf(can)).toMatchObject({ status: "stopped" });
  });

  scenario("a club member with a pool profile says 'stop': his club's opt-out reply as before, and his pool offers stop too", async ({ pool }) => {
    const home = await openClub(pool, "home", { name: "Home FC" });
    const pete = await memberInPool(pool, home, "pete", near(home));

    const ex = await pete.dm("stop messaging me");
    expect(ex.json).toMatchObject({ handled: "dm-subscription", cmd: "opt-out-all", poolStopped: true });
    pool.expectSent(ex.sent, [{ to: "home.pete", channel: "dm", text: /^Done, I'll only message you about payments from now on\./ }]);
    expect(await pool.db.one(`SELECT "subMatchInviteDm", "subRatingDm" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [pete.userId, home.group.orgId])).toEqual({
      subMatchInviteDm: false,
      subRatingDm: false,
    });
    expect(await pool.db.one(`SELECT status FROM "PoolProfile" WHERE "userId" = $1`, [pete.userId])).toEqual({ status: "stopped" });
    expect(await consentRecord(pool, pete.userId)).toEqual({ action: "withdraw", channel: "whatsapp", evidence: `whatsapp:${ex.messageId}:stop` });
  });

  scenario("a member who opted out BEFORE the pool: an offer to him is cancelled at dispatch and never sent; after a fresh 'start again' it goes", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", upcomingMatch: { daysFromNow: 2 } });
    const home = await openClub(pool, "home", { name: "Home FC", venue: near(fnf) });
    await pool.db.run(`UPDATE "Match" SET date = $2 WHERE id = $1`, [home.group.matchId, new Date(fnf.kickoff.getTime() + 2 * 24 * 3600_000)]);
    const pete = await memberInPool(pool, home, "pete", near(fnf));
    await pool.db.run(
      `UPDATE "Membership" SET "subMatchInviteDm" = false, "subBenchOfferDm" = false, "subTentativeDm" = false, "subRatingDm" = false, "subReminderDm" = false, "subPrefsUpdatedAt" = $2 WHERE "userId" = $1`,
      [pete.userId, new Date(Date.now() - 10 * 24 * 3600_000)],
    );

    await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    const polled = await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    expect(polled.out.filter((m) => m.to === "home.pete")).toEqual([]);
    const [offer] = await offersOf(pool, pete);
    expect(offer).toMatchObject({ outcome: "cancelled", sentAt: null });
    const job = await pool.db.one<{ status: string; failReason: string }>(`SELECT status, "failReason" FROM "PlatformJob" WHERE id = $1`, [offer.platformJobId]);
    expect(job).toEqual({ status: "failed", failReason: "cancelled: pool offer opted-out" });

    pool.note("he starts game offers again on his manage page (a fresh consent, after the opt-out): the next club's offer goes");
    await pool.db.run(`UPDATE "PoolProfile" SET "consentAt" = $2 WHERE "userId" = $1`, [pete.userId, new Date()]);
    const cheam = await openClub(pool, "cheam", { name: "Cheam Lads", venue: near(fnf), upcomingMatch: { daysFromNow: 5 } });
    await organiserAsks(pool, page, cheam, { places: 1, now: at(cheam.kickoff, -8) });
    const again = await pollPlatform(pool, { now: at(cheam.kickoff, -8) });
    expect(again.out.filter((m) => m.to === "home.pete" && m.purpose === "pool-offer")).toHaveLength(1);
  });
});
