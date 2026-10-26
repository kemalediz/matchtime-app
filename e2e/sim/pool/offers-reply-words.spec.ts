/**
 * POOL SCENARIOS: answering an offer in his own words (slice L6,
 * 2026-10-24). Plan 5.3. The reader is STUBBED here (`setPoolReplyStub`:
 * what the model would have said for each reply body), so every rule
 * around it runs for real through the DM route: the state prior, proof by
 * his own number, the tap link's own writers, the floor's one re-ask, and
 * every line rate-limited. $0. The real model on the same path is
 * `offers-reply-words-live.spec.ts` (paid).
 *
 *   yes, no, stop, a question, EN and TR; unsure: one re-ask; two open
 *   offers: which one; a club member's own question carries on to his
 *   club; offers stopped: nothing booked; after expiry: the one "gone"
 *   line; a place he took, given back in words.
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { E2E } from "../../helpers/env";
import { clearPoolReplyStub, setPoolReplyStub, stubCalls } from "../../helpers/stub";
import { askOf, at, extraMatch, near, offersOf, openClub, organiserAsks, pollPlatform, poolPlayer, tapLinkIn, type OpenClubOpts, type PoolPlayerOpts } from "./offers-world";
import type { PoolClub, PoolPerson, PoolWorld } from "./world";
import type { SentMessage } from "./transcript";

/** The pool switch for the DM route's writers (honoured only in test mode). */
const OPEN = { headers: { "x-mt-test-pool-open": "1" } };

type Club = PoolClub & { kickoff: Date };
type Player = PoolPerson & { userId: string };

/** The reply rules read the real clock: the offer reached him a minute ago. */
async function deliveredJustNow(pool: PoolWorld, p: { userId: string }, minutesAgo = 1): Promise<void> {
  // Only the offers just delivered at a pinned (future) poll time.
  await pool.db.run(`UPDATE "PoolOffer" SET "sentAt" = $2 WHERE "userId" = $1 AND "sentAt" > $3`, [p.userId, new Date(Date.now() - minutesAgo * 60_000), new Date()]);
}

/** A club asks the pool for one place and the offer reaches him. */
async function offerTo(
  pool: PoolWorld,
  page: Page,
  opts: { club?: OpenClubOpts & { key?: string }; player?: Partial<PoolPlayerOpts> & { key?: string } } = {},
): Promise<{ club: Club; ali: Player; offer: SentMessage }> {
  const { key = "fnf", ...clubOpts } = opts.club ?? {};
  const club = await openClub(pool, key, { name: "FNF", hq: true, ...clubOpts });
  const { key: pkey = "ali", ...playerOpts } = opts.player ?? {};
  const ali = await poolPlayer(pool, pkey, { name: "Ali Kaya", at: near(club), ...playerOpts });
  const ex = await organiserAsks(pool, page, club, { places: 1, now: at(club.kickoff, -8) });
  await pollPlatform(pool, { now: at(club.kickoff, -8) });
  await deliveredJustNow(pool, ali);
  const offer = ex.sent.find((m) => m.to === pkey && m.purpose === "pool-offer")!;
  expect(offer, "the offer reached him").toBeTruthy();
  return { club, ali, offer };
}

/** A club member who also joined the pool (L3's opt-in), living at `spot`. */
async function memberInPool(pool: PoolWorld, club: PoolClub, key: string, spot: { lat: number; lng: number }): Promise<Player> {
  const m = club.member(key);
  const userId = (await pool.userOf(m))!.id;
  const profileId = `sim-pool-p-${key}-${Date.now()}`;
  await pool.db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt", language, "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", "updatedAt")
     VALUES ($1, $2, 'active', now(), 1, 'web', 'req', now(), 'en', $3, 'SM1', $4, $5, 3, now())`,
    [profileId, userId, m.name ?? key, spot.lat, spot.lng],
  );
  await pool.db.run(`INSERT INTO "PoolSport" (id, "profileId", sport, formats) VALUES ($1, $2, 'football', '{}')`, [`${profileId}-s`, profileId]);
  for (const d of [0, 1, 2, 3, 4, 5, 6]) await pool.db.run(`INSERT INTO "PoolAvailability" (id, "profileId", day, "fromMin", "toMin") VALUES ($1, $2, $3, 0, 1440)`, [`${profileId}-a${d}`, profileId, d]);
  return Object.assign(m, { userId }) as Player;
}

const placeOf = (pool: PoolWorld, club: Club, p: { userId: string }) =>
  pool.db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [club.group.matchId, p.userId]);
const offerRow = async (pool: PoolWorld, p: { userId: string }) =>
  pool.db.one<{ outcome: string | null; repliedVia: string | null }>(`SELECT outcome, "repliedVia" FROM "PoolOffer" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [p.userId]);

scenarios("answering a pool offer in his own words", () => {
  scenario.afterEach(() => clearPoolReplyStub());

  scenario("yes in words (EN): his place, through the same writer as the tap; the organisers told without his number", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "yes mate, count me in": "accept" } }));
    const { club, ali } = await offerTo(pool, page);

    const ex = await ali.dm("yes mate, count me in", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-accept" });
    pool.expectSent(ex.sent, [
      { to: "fnf.hq", channel: "hq", text: /^🙋 Ali K from the MatchTime player pool took a place for .*New to MatchTime\.$/ },
      { to: "ali", channel: "dm", purpose: "pool-placed", text: /^✅ You're in: \*FNF\*/ },
    ]);
    pool.expectNoLeaks(ali.phoneVariants(), { to: ["fnf.hq"] });
    pool.expectNoLeaks(club.secrets(), { to: ["ali"] });
    expect((await placeOf(pool, club, ali))?.status).toBe("CONFIRMED");
    expect(await offerRow(pool, ali)).toEqual({ outcome: "accepted", repliedVia: "words" });
    expect(await askOf(pool, club)).toMatchObject({ status: "filled" });

    pool.note("the reader saw his offer's words, never a link");
    const turn = stubCalls(E2E.POOL_REPLY_STUB_FILE).filter((c) => c.label === "pool-reply").pop()!;
    expect(turn.user).toContain("⚽ *FNF* needs 1 player");
    expect(turn.user).not.toMatch(/https?:\/\//);
  });

  scenario("evet in Turkish: his place, the match details in Turkish", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "varım, yaz beni": "accept" } }));
    const { club, ali } = await offerTo(pool, page, { club: { key: "gs", name: "Galata FC" }, player: { key: "can", name: "Can Demir", lang: "tr" } });

    const ex = await ali.dm("varım, yaz beni", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-accept" });
    expect(ex.sent.find((m) => m.to === "can")?.text).toMatch(/^✅ Yerin hazır: \*Galata FC\*/);
    expect((await placeOf(pool, club, ali))?.status).toBe("CONFIRMED");
  });

  scenario("no in words (EN, then TR): declined by words, one thank-you, and that club stays away 14 days", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "nah busy that night sorry": "decline", "gelemem kusura bakma": "decline" } }));
    const { club, ali } = await offerTo(pool, page);
    const next = await extraMatch(pool, club, 72);

    const ex = await ali.dm("nah busy that night sorry", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-decline" });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-reply", text: /^Thanks for letting us know\. We'll message you about the next game near you\.\n\nYou get these because/ }]);
    expect(await offerRow(pool, ali)).toEqual({ outcome: "declined", repliedVia: "words" });
    expect(await placeOf(pool, club, ali)).toBeNull();

    const again = await organiserAsks(pool, page, club, { places: 1, now: at(next.kickoff, -8), matchId: next.id });
    expect(again.json.pool).toEqual({ ok: false, refusal: "none-near" });

    pool.note("in Turkish");
    const tr = await offerTo(pool, page, { club: { key: "gs", name: "Galata FC" }, player: { key: "can", name: "Can Demir", lang: "tr" } });
    const trEx = await tr.ali.dm("gelemem kusura bakma", OPEN);
    pool.expectSent(trEx.sent, [{ to: "can", purpose: "pool-reply", text: /^Haber verdiğin için teşekkürler\./ }]);
  });

  scenario("stop in words (EN and TR): offers stopped, the withdrawal recorded from his message, one line, no more offers", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "please stop sending me these": "stop", "beni listeden çıkar": "stop" } }));
    const { club, ali } = await offerTo(pool, page);

    const ex = await ali.dm("please stop sending me these", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-stop" });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-reply", text: /^Done, I've stopped game offers\. You can start them again here: https?:\/\/\S+\/r\/\S+$/ }]);
    expect(await pool.profileOf(ali)).toMatchObject({ status: "stopped" });
    const rec = await pool.db.one<{ action: string; channel: string; evidence: string }>(
      `SELECT action, channel, evidence FROM "PoolConsentRecord" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [ali.userId],
    );
    expect(rec).toEqual({ action: "withdraw", channel: "whatsapp", evidence: `whatsapp:${ex.messageId}:stop` });

    pool.note("stop again: already stopped, nothing more to say");
    pool.expectSent((await ali.dm("please stop sending me these", OPEN)).sent, []);

    pool.note("the next game near him: he is not asked");
    const next = await extraMatch(pool, club, 96);
    const again = await organiserAsks(pool, page, club, { places: 1, now: at(next.kickoff, -8), matchId: next.id });
    expect(again.json.pool).toEqual({ ok: false, refusal: "none-near" });

    pool.note("in Turkish");
    const tr = await offerTo(pool, page, { club: { key: "gs", name: "Galata FC" }, player: { key: "can", name: "Can Demir", lang: "tr" } });
    const trEx = await tr.ali.dm("beni listeden çıkar", OPEN);
    pool.expectSent(trEx.sent, [{ to: "can", purpose: "pool-reply", text: /^Tamam, maç tekliflerini durdurdum\./ }]);
  });

  scenario("a question (EN and TR): the offer's own facts and the link, nothing invented, no names or numbers", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "is there parking there?": "question", "nerede bu saha?": "question" } }));
    const { club, ali, offer } = await offerTo(pool, page, { club: { feePerPlayer: 6 } });

    const ex = await ali.dm("is there parking there?", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-facts" });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-reply", text: /^Here's everything I know about this game:\n⚽ \*FNF\* needs 1 player/ }]);
    const text = ex.sent[0].text;
    expect(text).toContain("📍 *Goals North Cheam*");
    expect(text).toContain("💷 £6 match fee");
    expect(text).toContain(`Reply here, or tap to answer: `);
    expect(text).toContain(tapLinkIn(offer));
    expect(text).not.toMatch(/parking/i);
    pool.expectNoLeaks(club.secrets(), { to: ["ali"] });
    expect(await offerRow(pool, ali)).toEqual({ outcome: null, repliedVia: null });

    pool.note("in Turkish");
    const tr = await offerTo(pool, page, { club: { key: "gs", name: "Galata FC" }, player: { key: "can", name: "Can Demir", lang: "tr" } });
    const trEx = await tr.ali.dm("nerede bu saha?", OPEN);
    pool.expectSent(trEx.sent, [{ to: "can", purpose: "pool-reply", text: /^Bu maç hakkında bildiklerim:\n⚽ \*Galata FC\*/ }]);
  });

  scenario("unsure: ONE re-ask with the link; unsure again: today's one line; then nothing; nothing booked", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "maybe, depends on work": "low:accept", "erm not sure yet": "low:accept", "we'll see": "low:accept" } }));
    const { club, ali, offer } = await offerTo(pool, page);

    const first = await ali.dm("maybe, depends on work", OPEN);
    expect(first.json).toMatchObject({ handled: "pool-reply-reask" });
    pool.expectSent(first.sent, [{ to: "ali", purpose: "pool-reply", text: /^Sorry, I didn't quite get that\. Would you like the place\? Reply yes or no, or tap to answer: / }]);
    expect(first.sent[0].text).toContain(tapLinkIn(offer));

    const second = await ali.dm("erm not sure yet", OPEN);
    pool.expectSent(second.sent, [{ to: "ali", purpose: "pool-reply", text: /^To answer the offer, tap the link: / }]);
    pool.expectSent((await ali.dm("we'll see", OPEN)).sent, []);
    expect(await placeOf(pool, club, ali)).toBeNull();
    expect(await offerRow(pool, ali)).toEqual({ outcome: null, repliedVia: null });
  });

  scenario("two open offers and a plain yes: asked which (both links), nothing booked; a swipe-reply to one books that one", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "yes I'll play": "accept" } }));
    const a = await openClub(pool, "a", { name: "Club A", hq: true, upcomingMatch: { daysFromNow: 2 } });
    const b = await openClub(pool, "b", { name: "Club B", hq: true, venue: near(a), upcomingMatch: { daysFromNow: 4 } });
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(a) });
    const sent: SentMessage[] = [];
    const exA = await organiserAsks(pool, page, a, { places: 1, now: at(a.kickoff, -8) });
    sent.push(exA.sent.find((m) => m.to === "ali")!);
    await pollPlatform(pool, { now: at(a.kickoff, -8) });
    // Club A's offer reached him two days ago (so the one-a-day cap lets
    // Club B's through today) and is still open until near its kickoff.
    await pool.db.run(`UPDATE "PoolOffer" SET "sentAt" = $4, "expiresAt" = $2 WHERE "userId" = $1 AND "orgId" = $3`, [
      ali.userId,
      at(a.kickoff, -1),
      a.group.orgId,
      new Date(Date.now() - 2 * 24 * 3600_000),
    ]);
    // Club B asks before Club A's game, so the poll's sweep leaves A's ask open.
    const exB = await organiserAsks(pool, page, b, { places: 1, now: at(a.kickoff, -7) });
    sent.push(exB.sent.find((m) => m.to === "ali")!);
    await pollPlatform(pool, { now: at(a.kickoff, -7) });
    await deliveredJustNow(pool, ali);
    await pool.db.run(`UPDATE "PoolOffer" SET "sentAt" = $3 WHERE "userId" = $1 AND "orgId" = $2`, [ali.userId, a.group.orgId, new Date(Date.now() - 2 * 60_000)]);

    const plain = await ali.dm("yes I'll play", OPEN);
    expect(plain.json).toMatchObject({ handled: "pool-reply-which" });
    pool.expectSent(plain.sent, [{ to: "ali", purpose: "pool-reply", text: /^You have 2 game offers open\. Which one do you mean\?/ }]);
    for (const m of sent) expect(plain.sent[0].text).toContain(tapLinkIn(m));
    expect((await offersOf(pool, ali)).map((o) => o.outcome)).toEqual([null, null]);

    pool.note("he swipe-replies to Club B's offer");
    const quoted = await ali.dm("yes I'll play", { ...OPEN, quote: { id: `wamid-${sent[1].id}`, text: sent[1].text } });
    expect(quoted.json).toMatchObject({ handled: "pool-reply-accept" });
    expect((await placeOf(pool, b, ali))?.status).toBe("CONFIRMED");
    expect(await placeOf(pool, a, ali)).toBeNull();
  });

  scenario("a club member: his own club's question carries on to his club; a clear yes to the offer is taken; after a club DM, plain words are his club's", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "what time is kickoff on thursday?": "neither", "count me in for that game": "accept", "yes": "accept" } }));
    const fnf = await openClub(pool, "fnf", { name: "FNF", hq: true, upcomingMatch: { daysFromNow: 2 } });
    const home = await openClub(pool, "home", { name: "Home FC", venue: near(fnf) });
    // His own club plays two days after the offered game, so he is not busy.
    await pool.db.run(`UPDATE "Match" SET date = $2 WHERE id = $1`, [home.group.matchId, new Date(fnf.kickoff.getTime() + 2 * 24 * 3600_000)]);
    const pete = await memberInPool(pool, home, "pete", near(fnf));
    await organiserAsks(pool, page, fnf, { places: 1, now: at(fnf.kickoff, -8) });
    await pollPlatform(pool, { now: at(fnf.kickoff, -8) });
    await deliveredJustNow(pool, pete);

    const own = await pete.dm("what time is kickoff on thursday?", OPEN);
    expect(String(own.json.handled ?? own.json.ignored ?? "")).not.toMatch(/^pool/);
    expect(own.sent.filter((m) => m.purpose === "pool-reply")).toEqual([]);

    const yes = await pete.dm("count me in for that game", OPEN);
    expect(yes.json).toMatchObject({ handled: "pool-reply-accept" });
    expect((await placeOf(pool, fnf, pete))?.status).toBe("CONFIRMED");

    pool.note("another member: his club DMs him after his offer reached him; his plain 'yes' is his club's, never read against the offer");
    const cheam = await openClub(pool, "cheam", { name: "Cheam Lads", venue: near(home), upcomingMatch: { daysFromNow: 5 } });
    const dan = await memberInPool(pool, home, "dan", near(home));
    await organiserAsks(pool, page, cheam, { places: 1, now: at(cheam.kickoff, -8) });
    await pollPlatform(pool, { now: at(cheam.kickoff, -8) });
    await deliveredJustNow(pool, dan, 10);
    await pool.db.run(`INSERT INTO "BotJob" (id, "orgId", kind, phone, text, "sentAt") VALUES ($1, $2, 'dm', $3, 'Are you in on Thursday?', $4)`, [
      `club-dm-${Date.now()}`,
      home.group.orgId,
      dan.phone.replace(/^\+/, ""),
      new Date(Date.now() - 60_000),
    ]);
    await pool.collect();
    const before = stubCalls(E2E.POOL_REPLY_STUB_FILE).filter((c) => c.label === "pool-reply").length;
    const plain = await dan.dm("yes", OPEN);
    expect(String(plain.json.handled ?? "")).not.toMatch(/^pool/);
    expect(stubCalls(E2E.POOL_REPLY_STUB_FILE).filter((c) => c.label === "pool-reply").length).toBe(before);
    expect(await placeOf(pool, cheam, dan)).toBeNull();
  });

  scenario("game offers stopped (on the manage page): a yes books nothing and gets one line with the way back", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "yes please": "accept", "yes!!": "accept" } }));
    const { club, ali } = await offerTo(pool, page);
    await pool.db.run(`UPDATE "PoolProfile" SET status = 'stopped', "stoppedAt" = $2 WHERE "userId" = $1`, [ali.userId, new Date()]);

    const ex = await ali.dm("yes please", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-profile-off" });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-reply", text: /^Your game offers are switched off, so I haven't booked anything\. You can switch them back on here: https?:\/\/\S+\/r\/\S+$/ }]);
    pool.expectSent((await ali.dm("yes!!", OPEN)).sent, []);
    expect(await placeOf(pool, club, ali)).toBeNull();
    expect(await offerRow(pool, ali)).toEqual({ outcome: null, repliedVia: null });
  });

  scenario("a yes after the offer ended: the one 'gone' line, nothing written", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "yes is it still going?": "accept", "hello??": "accept" } }));
    const { club, ali } = await offerTo(pool, page);
    await pool.db.run(`UPDATE "PoolOffer" SET "expiresAt" = $2 WHERE "userId" = $1`, [ali.userId, new Date(Date.now() - 30_000)]);

    const ex = await ali.dm("yes is it still going?", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-offer-gone" });
    pool.expectSent(ex.sent, [{ to: "ali", purpose: "pool-reply", text: /^Thanks\. That place with FNF has gone now\./ }]);
    pool.expectSent((await ali.dm("hello??", OPEN)).sent, []);
    expect(await placeOf(pool, club, ali)).toBeNull();
  });

  scenario("a place he took, given back in words: the place is free, the organisers told, his guest place withdrawn", async ({ pool, page }) => {
    stubbedOnly();
    pool.arm(() => setPoolReplyStub({ bodies: { "in": "accept", "sorry something came up, can't come any more": "decline" } }));
    const { club, ali } = await offerTo(pool, page);
    expect((await ali.dm("in", OPEN)).json).toMatchObject({ handled: "pool-reply-accept" });

    const ex = await ali.dm("sorry something came up, can't come any more", OPEN);
    expect(ex.json).toMatchObject({ handled: "pool-reply-pull-out" });
    expect(ex.sent.filter((m) => m.to === "fnf.hq").map((m) => m.text)).toEqual([expect.stringMatching(/^Ali K from the MatchTime player pool can no longer play on .*\. The place is open again\.$/)]);
    expect(ex.sent.find((m) => m.to === "ali")?.text).toMatch(/^Done, your place is free again\./);
    expect((await placeOf(pool, club, ali))?.status).toBe("DROPPED");
    expect(await pool.db.one(`SELECT result FROM "GuestPlace" WHERE "userId" = $1`, [ali.userId])).toEqual({ result: "withdrawn" });
  });
});
