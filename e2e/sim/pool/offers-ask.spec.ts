/**
 * POOL SCENARIOS: a club asks the pool, and who gets an offer (slice L5a,
 * 2026-10-24). Real routes, real database, model-free ($0):
 *
 *   the organisers' one tap (the match page's press) asks the pool; nobody
 *   is contacted before it; ONE offer DM per nearby player, carrying every
 *   fact of the approved spec's list, EN and TR, the tap link and the stop
 *   link, and never a member's name or number; every exclusion gets no
 *   message at all; the switch and the club's flag are checked when the
 *   offer is queued AND when it is sent; the press asks exactly what was
 *   ticked, now: partners, the pool, or both at once (Kemal, 2026-10-29;
 *   only the automatic ask gives partners an hour, `auto-ask.spec.ts`);
 *   the second wave only while places are open.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { askOf, at, far, near, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer } from "./offers-world";

const OFFER_EN = /⚽ \*FNF\* needs 1 player for a 7-a-side football game/;

/** An active partner club the club may ask (its organisers check each ask first). */
async function partnerClub(pool: Parameters<typeof openClub>[0], club: Awaited<ReturnType<typeof openClub>>): Promise<string> {
  const cheam = await pool.club("cheam", { name: "Cheam Lads" });
  const pid = `sim-pship-${Date.now()}`;
  await pool.db.run(
    `INSERT INTO "ClubPartnership" (id, "askerOrgId", "partnerOrgId", status, "partnerApproval", "askerAcceptedAt", "partnerAcceptedAt", "createdByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'active', 'each-ask', now(), now(), $4, now(), now())`,
    [pid, club.group.orgId, cheam.group.orgId, (await pool.userOf(club.member("owner")))!.id],
  );
  await pool.db.run(`UPDATE "Organisation" SET "partnerAskWhen" = 'on-request' WHERE id = $1`, [club.group.orgId]);
  return pid;
}

scenarios("a club asks the MatchTime player pool", () => {
  scenario("one tap asks the pool: ONE offer to the nearby player, every fact, nothing private, nothing before the tap", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true, feePerPlayer: 6, pool: { playStyle: "casual" } });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });

    pool.note("before anyone taps: nothing");
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer"`)).toBe(0);
    pool.expectSent(await pool.collect(), []);

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    expect(ex.json.pool).toMatchObject({ ok: true, waveSent: true });
    pool.expectSent(ex.sent, [{ to: "ali", channel: "dm", purpose: "pool-offer", text: OFFER_EN }]);
    const text = ex.sent[0].text;
    for (const fact of [
      /📅 \*\w+day \d+ \w+ at 20:00\* \(60 mins\)/,
      /📍 \*Goals North Cheam\*, Cheam Common Rd, Worcester Park KT4 8RH\. \d\.\d miles from you\. Map: https:\/\/www\.google\.com\/maps\/search\//,
      /🤝 Casual, friendly game\. A group of \d+ players/,
      /💷 £6 match fee/,
      /Reply here, or tap to answer: https?:\/\/\S+\/play\/offer\/\S+/,
      /Stop or change them: https?:\/\/\S+\/r\/\S+/,
    ]) {
      expect(text).toMatch(fact);
    }
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });

    const { out } = await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    expect(out.map((m) => m.to)).toEqual(["ali"]);
    expect((await offersOf(pool, ali))[0]).toMatchObject({ wave: 1, outcome: null });
    expect((await offersOf(pool, ali))[0].sentAt).not.toBeNull();
  });

  scenario("the offer in Turkish, for a player who signed up in Turkish", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", feePerPlayer: null, pool: { playStyle: "competitive" } });
    await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(fnf) });

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });

    pool.expectSent(ex.sent, [{ to: "can", purpose: "pool-offer", text: /⚽ \*FNF\*, 7'ye 7 futbol maçı için 1 oyuncu arıyor/ }]);
    const text = ex.sent[0].text;
    expect(text).toMatch(/sana \d,\d mil\. Harita: /);
    expect(text).toContain("🤝 Rekabetçi bir maç");
    expect(text).toMatch(/Buradan cevap ver ya da bağlantıya dokun: https?:\/\/\S+\/play\/offer\//);
    expect(text).toMatch(/Durdur ya da değiştir: https?:\/\/\S+\/r\//);
    pool.expectNoLeaks(fnf.secrets(), { to: ["can"] });
  });

  scenario("every exclusion gets no message: too far, wrong format, not free that day, already a member, paused, stopped, blocked", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const kickoffDay = new Date(fnf.kickoff.toLocaleString("en-US", { timeZone: "Europe/London" })).getDay();
    await poolPlayer(pool, "ok", { name: "Okan Yes", at: near(fnf) });
    await poolPlayer(pool, "far", { at: far(fnf) });
    await poolPlayer(pool, "eleven", { formats: [11], at: near(fnf) });
    await poolPlayer(pool, "busyday", { days: [(kickoffDay + 1) % 7], at: near(fnf) });
    await poolPlayer(pool, "paused", { status: "paused", at: near(fnf) });
    await poolPlayer(pool, "stopped", { status: "stopped", at: near(fnf) });
    const blocked = await poolPlayer(pool, "blocked", { at: near(fnf) });
    await pool.db.run(`INSERT INTO "PoolBlock" (id, "orgId", "userId", "by") VALUES ($1, $2, $3, 'club')`, [`blk-${blocked.userId}`, fnf.group.orgId, blocked.userId]);
    const member = await poolPlayer(pool, "member", { at: near(fnf) });
    await pool.db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER')`, [`mem-${member.userId}`, member.userId, fnf.group.orgId]);

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });

    pool.expectSent(ex.sent, [{ to: "ok", purpose: "pool-offer" }]);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1`, [fnf.group.orgId])).toBe(1);
  });

  scenario("the pool switch off, or the club's flag off: the ask is refused and nothing is queued", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const closed = await openClub(pool, "closed", { name: "Closed FC", pool: { featurePlayerPool: false } });
    await poolPlayer(pool, "ali", { at: near(fnf) });

    const off = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8), poolOpen: false });
    expect(off.json.pool).toEqual({ ok: false, refusal: "pool-closed" });
    pool.expectSent(off.sent, []);

    const flagOff = await organiserAsks(pool, page, closed, { places: 1, now: at(closed.kickoff, -8) });
    expect(flagOff.json.pool).toEqual({ ok: false, refusal: "pool-closed" });
    pool.expectSent(flagOff.sent, []);
    for (const club of [fnf, closed]) {
      expect(await pool.db.count(`SELECT count(*) FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId])).toBe(0);
      expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE "orgId" = $1`, [club.group.orgId])).toBe(0);
    }
  });

  scenario("the switch goes off between queueing and sending: the offer never goes, ends cancelled, the ask closes", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-offer" }]);

    pool.note("the kill switch is turned off before the Pi polls");
    const { out } = await pollPlatform(pool, { now: at(fnf.kickoff, -8), poolOpen: false });

    expect(out).toEqual([]);
    expect((await offersOf(pool, ali))[0]).toMatchObject({ outcome: "cancelled", sentAt: null });
    expect(await askOf(pool, fnf)).toMatchObject({ status: "closed", closeReason: "switched-off" });
    const job = await pool.db.one<{ status: string; failReason: string }>(`SELECT status, "failReason" FROM "PlatformJob" WHERE id = $1`, [
      (await offersOf(pool, ali))[0].platformJobId,
    ]);
    expect(job).toMatchObject({ status: "failed" });
    expect(job!.failReason).toMatch(/^cancelled: /);
  });

  scenario("he pauses himself after the offer was queued: it is never sent", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });
    await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pool.db.run(`UPDATE "PoolProfile" SET status = 'paused', "pausedReason" = 'self', "pausedAt" = now() WHERE "userId" = $1`, [ali.userId]);

    const { out } = await pollPlatform(pool, { now: at(fnf.kickoff, -8) });

    expect(out).toEqual([]);
    expect((await offersOf(pool, ali))[0]).toMatchObject({ outcome: "cancelled" });
  });

  scenario("waves: about 4 first; the rest 30 minutes later only while places are open; never a second wave once filled", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const keys = ["p1", "p2", "p3", "p4", "p5", "p6"];
    for (const k of keys) await poolPlayer(pool, k, { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: t0 });
    expect(ex.sent.filter((m) => m.purpose === "pool-offer")).toHaveLength(4);
    await pollPlatform(pool, { now: t0 });

    const early = await pollPlatform(pool, { now: new Date(t0.getTime() + 29 * 60_000) });
    expect(early.queued.filter((m) => m.purpose === "pool-offer")).toEqual([]);

    const later = await pollPlatform(pool, { now: new Date(t0.getTime() + 31 * 60_000) });
    expect(later.queued.filter((m) => m.purpose === "pool-offer")).toHaveLength(2);
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE wave = 2 AND "orgId" = $1`, [fnf.group.orgId])).toBe(2);
  });

  scenario("waves skipped: the club's own player takes the last place before the second wave, so it never goes", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF", maxPlayers: 1 });
    for (const k of ["p1", "p2", "p3", "p4", "p5", "p6"]) await poolPlayer(pool, k, { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);
    await organiserAsks(pool, page, fnf, { places: 1, now: t0 });
    await pollPlatform(pool, { now: t0 });

    pool.note("a member says IN: the one place is taken");
    const pete = await pool.userOf(fnf.member("pete"));
    await pool.db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 1, now())`, [
      `att-${pete!.id}`,
      fnf.group.matchId,
      pete!.id,
    ]);

    const later = await pollPlatform(pool, { now: new Date(t0.getTime() + 31 * 60_000) });
    expect(later.queued.filter((m) => m.purpose === "pool-offer")).toEqual([]);
    expect(await askOf(pool, fnf)).toMatchObject({ status: "filled", closeReason: "filled" });
    expect(await pool.db.count(`SELECT count(*) FROM "PoolOffer" WHERE outcome = 'expired' AND "orgId" = $1`, [fnf.group.orgId])).toBe(4);
  });

  scenario("both ticked (Kemal, 2026-10-29): the partner club and the pool are asked at once, in one round; the pool never waits", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const pid = await partnerClub(pool, fnf);
    await poolPlayer(pool, "ali", { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: t0, partnershipIds: [pid] });
    expect(ex.json.partner).toMatchObject({ asked: 1 });
    expect(ex.json.pool).toMatchObject({ ok: true, waveSent: true });
    expect(ex.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ali"]);
    const ask = await askOf(pool, fnf);
    expect(ask?.roundId).toBeTruthy();
    expect(await pool.db.count(`SELECT count(*) FROM "PartnerAsk" WHERE "roundId" = $1`, [ask!.roundId])).toBe(1);
  });

  scenario("partner clubs only ticked: the partner club is asked now, the pool is not asked at all", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const pid = await partnerClub(pool, fnf);
    await poolPlayer(pool, "ali", { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: t0, pool: false, partnershipIds: [pid] });
    expect(ex.json.partner).toMatchObject({ asked: 1 });
    expect(ex.json.pool).toBeNull();
    expect(await askOf(pool, fnf)).toBeFalsy();
    const later = await pollPlatform(pool, { now: new Date(t0.getTime() + 61 * 60_000) });
    expect(later.queued.filter((m) => m.purpose === "pool-offer")).toEqual([]);
  });

  scenario("the pool only ticked, with a partner round already open on the match: the pool is asked now, no new partner ask", async ({ pool, page }) => {
    const fnf = await openClub(pool, "fnf", { name: "FNF" });
    const pid = await partnerClub(pool, fnf);
    await poolPlayer(pool, "ali", { at: near(fnf) });
    const t0 = at(fnf.kickoff, -8);
    await organiserAsks(pool, page, fnf, { places: 1, now: t0, pool: false, partnershipIds: [pid] });

    const ex = await organiserAsks(pool, page, fnf, { places: 1, now: new Date(t0.getTime() + 5 * 60_000) });
    expect(ex.json.partner).toBeNull();
    expect(ex.json.pool).toMatchObject({ ok: true, waveSent: true });
    expect(ex.sent.filter((m) => m.purpose === "pool-offer").map((m) => m.to)).toEqual(["ali"]);
    expect(await pool.db.count(`SELECT count(*) FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [fnf.group.orgId])).toBe(1);
  });
});
