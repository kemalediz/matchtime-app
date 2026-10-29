/**
 * POOL SCENARIOS: the automatic ask includes the pool (slice L9,
 * 2026-10-24). Real routes, real database, model-free ($0).
 *
 * The trigger is the scheduler's poll (`/api/whatsapp/due-posts`, the
 * automatic partner ask's own sweep) at a pinned clock; what goes out is
 * the Pi's platform poll. A club that switched on "Ask the player pool
 * automatically" (and may ask the pool) has the pool join its automatic ask
 * on match day, from its time to the cut-off, with a place open and its own
 * bench empty: an hour after the partners it asked, or at once with no
 * partner club, exactly as an organiser's tap would (the same ask, the same
 * offer). Nothing for a club with the switch off, the pool flag off, the
 * global switch off, someone on its bench, or partners on When we ask.
 * Quiet hours hold the offer. The organisers hear one line.
 */
import { scenario, scenarios, expect } from "./fixtures";
import { askOf, at, londonOn, near, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer, type OpenClubOpts } from "./offers-world";
import type { PoolWorld } from "./world";
import type { SentMessage } from "./transcript";
import { E2E } from "../../helpers/env";

const OFFER_EN = /⚽ \*FNF\* needs 1 player for a 7-a-side football game/;
const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };

type Club = Awaited<ReturnType<typeof openClub>>;

/** A club on match day's automatic ask: its time, the partner setting, the pool switches. */
async function autoClub(
  pool: PoolWorld,
  key: string,
  opts: OpenClubOpts & { askTime?: string; partnerAskWhen?: "off" | "on-request" | "auto"; poolAutoAsk?: boolean; featurePlayerPool?: boolean; language?: "en" | "tr" } = {},
): Promise<Club> {
  const { askTime, partnerAskWhen, poolAutoAsk, featurePlayerPool, language, ...clubOpts } = opts;
  // One place open (nobody IN yet): the automatic ask asks for every open place.
  const club = await openClub(pool, key, { maxPlayers: 1, ...clubOpts, pool: { ...(clubOpts.pool ?? {}), featurePlayerPool: featurePlayerPool ?? true, poolAutoAsk: poolAutoAsk ?? true } });
  await pool.db.run(`UPDATE "Organisation" SET "partnerAskTime" = $2, "partnerAskWhen" = $3, language = $4 WHERE id = $1`, [
    club.group.orgId,
    askTime ?? "12:00",
    partnerAskWhen ?? "off",
    language ?? "en",
  ]);
  return club;
}

/** A partner club FNF asks (its own game on another day, so never short at the same time). */
async function partnerOf(pool: PoolWorld, asker: Club, key: string, name: string): Promise<void> {
  const partner = await pool.club(key, { name, upcomingMatch: false });
  await pool.db.run(
    `INSERT INTO "ClubPartnership" (id, "askerOrgId", "partnerOrgId", status, "partnerApproval", "askerAcceptedAt", "partnerAcceptedAt", "createdByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'active', 'each-ask', now(), now(), $4, now(), now())`,
    [`sim-pship-${key}-${Date.now()}`, asker.group.orgId, partner.group.orgId, (await pool.userOf(asker.member("owner")))!.id],
  );
}

/** The scheduler's poll for the club at `now` (the automatic ask runs in it). */
async function schedulerPoll(pool: PoolWorld, club: Club, opts: { now: Date; poolOpen?: boolean }): Promise<SentMessage[]> {
  pool.note(`(the scheduler polls ${club.key} at ${opts.now.toISOString()})`);
  const res = await pool.request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(club.group.groupId)}`, {
    // Today's Pi polls /platform-jobs itself and says so (platform-jobs.ts
    // PLATFORM_JOBS_CAPABLE_HEADER); without it due-posts would hand it
    // platform DMs (the legacy bridge).
    headers: { ...PI, "x-mt-platform-jobs": "1", "x-test-now": opts.now.toISOString(), "x-mt-test-pool-open": opts.poolOpen === false ? "0" : "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return pool.collect();
}

const offers = (ms: readonly SentMessage[]) => ms.filter((m) => m.purpose === "pool-offer");
const autoLines = (ms: readonly SentMessage[]) => ms.filter((m) => /Your automatic ask|Otomatik isteğiniz/.test(m.text));
const poolAsksOf = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ via: string; roundId: string | null; places: number; approvedByUserId: string | null }>(
    `SELECT via, "roundId", places, "approvedByUserId" FROM "PoolAsk" WHERE "orgId" = $1`,
    [club.group.orgId],
  );

scenarios("the automatic ask includes the MatchTime player pool", () => {
  scenario("no partner club: at the club's time the pool is asked at once, ONE offer, the same offer a tap sends, one line to the organisers", async ({ pool }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF", feePerPlayer: 6, pool: { playStyle: "casual" } });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });

    pool.note("before the club's time: nothing");
    const early = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "11:55") });
    expect(offers(early)).toEqual([]);
    expect(await poolAsksOf(pool, fnf)).toEqual([]);

    const sent = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:05") });
    pool.expectSent(offers(sent), [{ to: "ali", channel: "dm", purpose: "pool-offer", text: OFFER_EN }]);
    for (const fact of [/📍 \*Goals North Cheam\*/, /🤝 Casual, friendly game/, /💷 £6 match fee/, /Reply here, or tap to answer: https?:\/\/\S+\/play\/offer\//, /Stop or change them: https?:\/\/\S+\/r\//]) {
      expect(offers(sent)[0].text).toMatch(fact);
    }
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });
    expect(await poolAsksOf(pool, fnf)).toEqual([{ via: "auto", roundId: null, places: 1, approvedByUserId: null }]);
    const lines = autoLines(sent);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toMatch(/so I'm asking nearby players from the MatchTime player pool/);
    expect(lines[0].text).not.toMatch(/partner/);

    const { out } = await pollPlatform(pool, { now: londonOn(fnf.kickoff, 0, "12:05") });
    expect(out.map((m) => m.to)).toEqual(["ali"]);
    expect((await offersOf(pool, ali))[0]).toMatchObject({ wave: 1, outcome: null });

    pool.note("the next polls: once per match, never again");
    const later = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "13:30") });
    expect(offers(later)).toEqual([]);
    expect(autoLines(later)).toEqual([]);
    expect(await poolAsksOf(pool, fnf)).toHaveLength(1);
  });

  scenario("with a partner club: the partner is asked, the pool joins the same round and waits the partners' hour", async ({ pool }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF", partnerAskWhen: "auto" });
    await partnerOf(pool, fnf, "cheam", "Cheam Lads");
    await poolPlayer(pool, "ali", { at: near(fnf) });
    const t0 = londonOn(fnf.kickoff, 0, "12:05");

    const sent = await schedulerPoll(pool, fnf, { now: t0 });
    const partnerAsk = await pool.db.one<{ requestedVia: string; roundId: string | null }>(
      `SELECT "requestedVia", "roundId" FROM "PartnerAsk" WHERE "askerOrgId" = $1`,
      [fnf.group.orgId],
    );
    expect(partnerAsk).toMatchObject({ requestedVia: "auto" });
    expect(partnerAsk!.roundId).toBeTruthy();
    expect(await poolAsksOf(pool, fnf)).toEqual([{ via: "auto", roundId: partnerAsk!.roundId, places: 1, approvedByUserId: null }]);
    expect(offers(sent)).toEqual([]);
    const lines = autoLines(sent);
    expect(lines.map((m) => m.text)).toEqual([
      expect.stringMatching(/Your automatic ask: .*Cheam Lads/),
      expect.stringMatching(/I'll ask nearby players from the MatchTime player pool if your partner clubs have not filled it within the hour/),
    ]);

    const at59 = await pollPlatform(pool, { now: new Date(t0.getTime() + 59 * 60_000) });
    expect(offers(at59.queued)).toEqual([]);
    const at61 = await pollPlatform(pool, { now: new Date(t0.getTime() + 61 * 60_000) });
    expect(offers(at61.queued).map((m) => m.to)).toEqual(["ali"]);
    expect(offers(at61.queued)[0].text).toMatch(OFFER_EN);
  });

  scenario("someone on the club's own bench: its own player first, the pool is not asked", async ({ pool }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF" });
    await poolPlayer(pool, "ali", { at: near(fnf) });
    const pete = await pool.userOf(fnf.member("pete"));
    await pool.db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'BENCH', 1, now())`, [
      `att-bench-${pete!.id}`,
      fnf.group.matchId,
      pete!.id,
    ]);

    const sent = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:05") });
    expect(offers(sent)).toEqual([]);
    expect(autoLines(sent)).toEqual([]);
    expect(await poolAsksOf(pool, fnf)).toEqual([]);

    pool.note("he drops off the bench: now the pool is asked (the bench was the only reason)");
    await pool.db.run(`DELETE FROM "Attendance" WHERE id = $1`, [`att-bench-${pete!.id}`]);
    const after = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:10") });
    expect(offers(after).map((m) => m.to)).toEqual(["ali"]);
  });

  scenario("the switch off (the default): the pool is not asked; the organisers can still tap", async ({ pool, page }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF", poolAutoAsk: false });
    await poolPlayer(pool, "ali", { at: near(fnf) });

    const sent = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:05") });
    expect(offers(sent)).toEqual([]);
    expect(await poolAsksOf(pool, fnf)).toEqual([]);

    const tap = await organiserAsks(pool, page, fnf, { places: 1, now: londonOn(fnf.kickoff, 0, "12:10") });
    expect(tap.json.pool).toMatchObject({ ok: true });
    expect(await poolAsksOf(pool, fnf)).toEqual([expect.objectContaining({ via: "page" })]);
  });

  scenario("the club's pool flag off, or the global switch off: the pool is not asked", async ({ pool }) => {
    const flagOff = await autoClub(pool, "closed", { name: "Closed FC", featurePlayerPool: false });
    await poolPlayer(pool, "ali", { at: near(flagOff) });
    const a = await schedulerPoll(pool, flagOff, { now: londonOn(flagOff.kickoff, 0, "12:05") });
    expect(offers(a)).toEqual([]);
    expect(await poolAsksOf(pool, flagOff)).toEqual([]);

    const fnf = await autoClub(pool, "fnf", { name: "FNF" });
    await poolPlayer(pool, "bob", { at: near(fnf) });
    const b = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:05"), poolOpen: false });
    expect(offers(b)).toEqual([]);
    expect(autoLines(b)).toEqual([]);
    expect(await poolAsksOf(pool, fnf)).toEqual([]);

    pool.note("the global switch back on: the same club is asked at the next poll");
    const c = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:10") });
    expect(offers(c).map((m) => m.to)).toEqual(["bob"]);
  });

  scenario("partners on When we ask: the organisers decide every round, so the pool is not asked by itself", async ({ pool }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF", partnerAskWhen: "on-request" });
    await partnerOf(pool, fnf, "cheam", "Cheam Lads");
    await poolPlayer(pool, "ali", { at: near(fnf) });

    const sent = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:05") });
    expect(offers(sent)).toEqual([]);
    expect(autoLines(sent)).toEqual([]);
    expect(await poolAsksOf(pool, fnf)).toEqual([]);
    expect(await pool.db.count(`SELECT count(*) FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [fnf.group.orgId])).toBe(0);

    pool.note("the club moves partners to Automatically at a time: both are asked");
    await pool.db.run(`UPDATE "Organisation" SET "partnerAskWhen" = 'auto' WHERE id = $1`, [fnf.group.orgId]);
    await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:10") });
    expect(await poolAsksOf(pool, fnf)).toEqual([expect.objectContaining({ via: "auto" })]);
  });

  scenario("the organisers already tapped for the pool: the automatic ask does not ask it again", async ({ pool, page }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF" });
    await poolPlayer(pool, "ali", { at: near(fnf) });
    await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -30) });

    const sent = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:05") });
    expect(offers(sent)).toEqual([]);
    expect(autoLines(sent)).toEqual([]);
    expect(await poolAsksOf(pool, fnf)).toEqual([expect.objectContaining({ via: "page" })]);
  });

  scenario("no night hold (Kemal, 2026-10-29): the automatic ask at 07:05 sends its offer at once", async ({ pool }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF", askTime: "07:00" });
    const ali = await poolPlayer(pool, "ali", { at: near(fnf) });

    const sent = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "07:05") });
    expect(offers(sent).map((m) => m.to)).toEqual(["ali"]);
    expect(offers(sent)[0].sendAfter ?? null).toBeNull();

    // (Scenarios share a database, so only Ali's are looked at.)
    const toAli = (ms: readonly SentMessage[]) => offers(ms).filter((m) => m.to === "ali");
    const poll = await pollPlatform(pool, { now: londonOn(fnf.kickoff, 0, "07:06") });
    expect(toAli(poll.out)).toHaveLength(1);
    expect((await offersOf(pool, ali))[0].sentAt).not.toBeNull();
  });

  scenario("in Turkish: the Turkish player gets the same Turkish offer a tap sends; a Turkish club's organisers read the line in Turkish", async ({ pool }) => {
    const fnf = await autoClub(pool, "fnf", { name: "FNF", language: "tr", feePerPlayer: null, pool: { playStyle: "competitive" } });
    await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(fnf) });

    const sent = await schedulerPoll(pool, fnf, { now: londonOn(fnf.kickoff, 0, "12:05") });
    pool.expectSent(offers(sent), [{ to: "can", purpose: "pool-offer", text: /⚽ \*FNF\*, 7'ye 7 futbol maçı için 1 oyuncu arıyor/ }]);
    expect(offers(sent)[0].text).toContain("🤝 Rekabetçi bir maç");
    expect(offers(sent)[0].text).toMatch(/Buradan cevap ver ya da bağlantıya dokun: https?:\/\/\S+\/play\/offer\//);
    const lines = autoLines(sent);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toMatch(/Otomatik isteğiniz: .* MatchTime oyuncu havuzundaki yakın oyunculara soruyorum/);
    pool.expectNoLeaks(fnf.secrets(), { to: ["can"] });
  });
});
