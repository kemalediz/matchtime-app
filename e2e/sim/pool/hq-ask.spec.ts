/**
 * POOL SCENARIOS: the organisers ask the MatchTime player pool from their
 * admin group (HQ), in their own words or with a YES to the short-squad
 * notice (local player pool L10, 2026-10-24).
 *
 * Real routes, real database. The model is STUBBED ($0): the router's route
 * and the admin extractor's facts ("recruit, from the pool") are what the
 * stub says; whether the real model says them is the paid check
 * (`scripts/live-check-hq-pool.ts` and the existing HQ suites). Everything
 * after is the shipped code: the outward gate, who may ask, the safe-YES
 * rule, `requestPoolAsk` (L5a's tap) with every rule, the offer queued as a
 * platform DM, and the one HQ line.
 *
 * The notice is the scheduler's own short-squad notice (`/api/whatsapp/
 * due-posts`, an admin-group Pi, 3 to 4 hours before kickoff), claimed and
 * acked as the Pi does, so its pool line is logged as MatchTime's question.
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { askOf, extraMatch, near, offersOf, openClub, poolPlayer, type OpenClubOpts } from "./offers-world";
import type { PoolWorld } from "./world";
import type { SentMessage } from "./transcript";
import { E2E } from "../../helpers/env";
import { clearPipelineStubs, engineOn } from "../../helpers/stub";
import { londonDateTimeToUtc } from "../../../src/lib/london-time";
import { formatLondon } from "../../../src/lib/london-time";

const PI = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ADMIN_FACTS = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0, clubRef: "" };
const fromPool = (toMatchTime = true) => ({ action: "recruit", ...ADMIN_FACTS, playersFrom: "pool", toMatchTime });

const ASK_EN = "@Match Time ask the pool for a player";
const ASK_TR = "@Match Time havuzdan bir oyuncu bul";
const SHALL_WE = "shall we try the pool?";
const BIBS = "who is bringing the bibs?";

type Club = Awaited<ReturnType<typeof openClub>>;

/** A club with HQ, the pool on, one place open, its game at 20:00 London
 *  two days from now (so the notice and the asks fall in the day). */
async function hqClub(pool: PoolWorld, key: string, opts: OpenClubOpts & { language?: "en" | "tr" } = {}): Promise<Club> {
  const { language, ...clubOpts } = opts;
  const club = await openClub(pool, key, { name: "FNF", hq: true, maxPlayers: 1, ...clubOpts });
  const day = formatLondon(new Date(Date.now() + 48 * 3600_000), "yyyy-MM-dd");
  const kickoff = londonDateTimeToUtc(day, "20:00");
  await pool.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [club.group.matchId, kickoff]);
  // The organisers get the short-squad notice; the partner cut-off is 2
  // hours, so the 3-hour notice can still offer the pool.
  await pool.db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'organisers', "partnerAskCutoffHours" = 2, language = $2 WHERE id = $1`, [
    club.group.orgId,
    language ?? "en",
  ]);
  return Object.assign(club, { kickoff });
}

const hoursBefore = (club: Club, h: number) => new Date(club.kickoff.getTime() - h * 3600_000);
const poolAsks = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ via: string; approvedByUserId: string | null; places: number; matchId: string }>(
    `SELECT via, "approvedByUserId", places, "matchId" FROM "PoolAsk" WHERE "orgId" = $1 ORDER BY "createdAt"`,
    [club.group.orgId],
  );
const groupPosts = (ms: readonly SentMessage[], club: Club) => ms.filter((m) => m.to === `${club.key}.group`);
const offers = (ms: readonly SentMessage[]) => ms.filter((m) => m.purpose === "pool-offer");

/** The scheduler's poll for the club at `now`, from a Pi that can post in
 *  the admin group; every admin-group post it hands out is acked as sent. */
async function noticePoll(pool: PoolWorld, club: Club, now: Date): Promise<Array<{ key: string; text: string }>> {
  pool.note(`(the scheduler polls ${club.key} at ${now.toISOString()})`);
  const res = await pool.request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(club.group.groupId)}`, {
    headers: { ...PI, "x-mt-platform-jobs": "1", "x-mt-pi-caps": "admin-group", "x-test-now": now.toISOString(), "x-mt-test-pool-open": "1" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { instructions } = (await res.json()) as { instructions: Array<{ kind: string; key: string; text?: string; matchId?: string; hqAskRef?: unknown }> };
  const posts = instructions.filter((i) => i.kind === "admin-group-message");
  for (const p of posts) {
    // Server-side bookkeeping never reaches the Pi.
    expect(p.hqAskRef).toBeUndefined();
    pool.note(`(MatchTime posts in ${club.key}'s HQ) ${p.text ?? ""}`);
    const ack = await pool.request.post("/api/whatsapp/ack", { headers: PI, data: { key: p.key, kind: p.kind, matchId: p.matchId, waMessageId: `true_${p.key}@g.us_3EB0${Math.random().toString(16).slice(2, 10).toUpperCase()}` } });
    expect(ack.status()).toBe(200);
  }
  await pool.collect();
  return posts.map((p) => ({ key: p.key, text: p.text ?? "" }));
}

scenarios("the organisers ask the MatchTime player pool from HQ", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("in words (EN): one HQ line, the nearby player gets the same offer a tap sends, nothing in the players' group", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "fnf");
    const ali = await poolPlayer(pool, "ali", { name: "Ali Kaya", at: near(fnf) });
    pool.arm(() => engineOn({ [ASK_EN]: { route: "ask_group", facts: fromPool() } }));

    const ex = await fnf.hq.say("owner", ASK_EN, { now: hoursBefore(fnf, 30), poolOpen: true });

    pool.expectSent(ex.sent, [
      { to: "fnf.hq", channel: "hq", text: /^🔎 Asking nearby players from the MatchTime player pool for 1 place on .+, 20:00\. I'll tell you here when one takes a place\.$/ },
      { to: "ali", channel: "dm", purpose: "pool-offer", text: /⚽ \*FNF\* needs 1 player/ },
    ]);
    expect(groupPosts(pool.sent, fnf)).toEqual([]);
    const owner = await pool.userOf(fnf.member("owner"));
    expect(await poolAsks(pool, fnf)).toEqual([{ via: "words", approvedByUserId: owner!.id, places: 1, matchId: fnf.group.matchId }]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });
    expect(ex.json).toMatchObject({ handled: true, outcome: "hq-pool-asked", react: "✅" });
  });

  scenario("in words (TR): the Turkish line, the same ask", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "tr1", { language: "tr" });
    await poolPlayer(pool, "can", { name: "Can Demir", lang: "tr", at: near(fnf) });
    pool.arm(() => engineOn({ [ASK_TR]: { route: "ask_group", facts: fromPool() } }));

    const ex = await fnf.hq.say("owner", ASK_TR, { now: hoursBefore(fnf, 30), poolOpen: true });

    expect(ex.sent.find((m) => m.to === "tr1.hq")?.text).toMatch(/^🔎 .+ maçı için MatchTime oyuncu havuzundaki yakın oyunculara soruyorum \(1 kişi\)\./);
    expect(offers(ex.sent).map((m) => m.to)).toEqual(["can"]);
    expect((await poolAsks(pool, fnf)).map((a) => a.via)).toEqual(["words"]);
  });

  scenario("the pool not open for the club: one helpful line, nobody asked, nothing posted in the players' group", async ({ pool }) => {
    stubbedOnly();
    const off = await hqClub(pool, "off", { pool: { featurePlayerPool: false } });
    await poolPlayer(pool, "bea", { at: near(off) });
    pool.arm(() => engineOn({ [ASK_EN]: { route: "ask_group", facts: fromPool() } }));

    const ex = await off.hq.say("owner", ASK_EN, { now: hoursBefore(off, 30), poolOpen: true });

    pool.expectSent(ex.sent, [
      { to: "off.hq", channel: "hq", text: /^\*Player pool:\* I didn't ask nearby players: the MatchTime player pool is switched off for your club\. An owner or admin can switch it on here, or I can ask your players' group instead: \S+\/admin\/settings#player-pool$/ },
    ]);
    expect(await poolAsks(pool, off)).toEqual([]);
    expect(ex.json).toMatchObject({ outcome: "hq-pool-not-asked", react: null });

    // The global switch off: the same line.
    const fnf = await hqClub(pool, "sw");
    const closed = await fnf.hq.say("owner", ASK_EN, { now: hoursBefore(fnf, 30), poolOpen: false });
    pool.expectSent(closed.sent, [{ to: "sw.hq", channel: "hq", text: /^\*Player pool:\* the MatchTime player pool is not open for your club yet\./ }]);
    expect(await poolAsks(pool, fnf)).toEqual([]);
  });

  scenario("someone in HQ who is not an organiser: the one line naming who can, nobody asked", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "np");
    await poolPlayer(pool, "cem", { at: near(fnf) });
    pool.arm(() => engineOn({ [ASK_EN]: { route: "ask_group", facts: fromPool() } }));

    const ex = await fnf.hq.say("pete", ASK_EN, { now: hoursBefore(fnf, 30), poolOpen: true });

    pool.expectSent(ex.sent, [{ to: "np.hq", channel: "hq", text: /^Only .*Oscar.* can change that\.$/ }]);
    expect(await poolAsks(pool, fnf)).toEqual([]);
  });

  scenario("untagged chatter, and the organisers asking each other about the pool: silent, nobody asked", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "chat");
    await poolPlayer(pool, "dua", { at: near(fnf) });
    pool.arm(() =>
      engineOn({
        [BIBS]: { route: "none" },
        // The router heard an ask; the extractor says it is said to the others.
        [SHALL_WE]: { route: "ask_group", facts: fromPool(false) },
      }),
    );

    for (const text of [BIBS, SHALL_WE]) {
      const ex = await fnf.hq.say("owner", text, { now: hoursBefore(fnf, 30), poolOpen: true });
      pool.expectSent(ex.sent, []);
    }
    expect(await poolAsks(pool, fnf)).toEqual([]);
  });

  scenario("YES to the short-squad notice: the notice offers the pool in HQ, the YES asks it, via the notice", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "yes");
    const eli = await poolPlayer(pool, "eli", { at: near(fnf) });
    pool.arm(() => engineOn({ yes: { route: "approve" }, [BIBS]: { route: "none" } }));

    const posts = await noticePoll(pool, fnf, hoursBefore(fnf, 3.5));
    const notice = posts.find((p) => /MatchTime pool/.test(p.text));
    expect(notice?.text).toMatch(/🔎 Or I can ask nearby players from the MatchTime pool \(a few near you\): reply YES here, or open the match page: \S+\/matches\//);
    // Nobody is contacted before the organisers say so.
    expect(await offersOf(pool, eli)).toEqual([]);

    // Chatter while it waits stays the organisers' own.
    pool.expectSent((await fnf.hq.say("alice", BIBS, { now: hoursBefore(fnf, 3.45), poolOpen: true })).sent, []);

    // After that chatter a bare YES is checked once...
    const first = await fnf.hq.say("owner", "yes", { now: hoursBefore(fnf, 3.4), poolOpen: true });
    pool.expectSent(first.sent, [{ to: "yes.hq", channel: "hq", text: /^Is that YES to asking nearby players from the MatchTime player pool for .+\?$/ }]);
    expect(await poolAsks(pool, fnf)).toEqual([]);

    // ...and the YES that answers that question asks the pool.
    const ex = await fnf.hq.say("owner", "yes", { now: hoursBefore(fnf, 3.39), poolOpen: true });
    pool.expectSent(ex.sent, [
      { to: "yes.hq", channel: "hq", text: /^🔎 Asking nearby players from the MatchTime player pool for 1 place on / },
      { to: "eli", channel: "dm", purpose: "pool-offer" },
    ]);
    expect((await poolAsks(pool, fnf)).map((a) => a.via)).toEqual(["notice"]);

    // Asked: nothing waits any more, a second YES asks nothing again.
    const again = await fnf.hq.say("owner", "yes", { now: hoursBefore(fnf, 3.3), poolOpen: true });
    expect(again.sent.filter((m) => m.purpose === "pool-offer")).toEqual([]);
    expect(await poolAsks(pool, fnf)).toHaveLength(1);
    expect(await askOf(pool, fnf)).toMatchObject({ status: "open" });
  });

  scenario("YES quoting the notice asks it at once; a YES to it from a player is the one line", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "quote");
    await poolPlayer(pool, "fay", { at: near(fnf) });
    pool.arm(() => engineOn({ yes: { route: "approve" }, "go on then": { route: "approve" } }));
    const [notice] = (await noticePoll(pool, fnf, hoursBefore(fnf, 3.5))).filter((p) => /MatchTime pool/.test(p.text));

    const player = await fnf.hq.say("pete", "yes", { now: hoursBefore(fnf, 3.4), poolOpen: true, quote: { text: notice.text } });
    pool.expectSent(player.sent, [{ to: "quote.hq", channel: "hq", text: /^Only .* can change that\.$/ }]);
    expect(await poolAsks(pool, fnf)).toEqual([]);

    const ex = await fnf.hq.say("alice", "go on then", { now: hoursBefore(fnf, 3.3), poolOpen: true, quote: { text: notice.text } });
    expect(ex.sent.find((m) => m.to === "quote.hq")?.text).toMatch(/^🔎 Asking nearby players/);
    expect(offers(ex.sent).map((m) => m.to)).toEqual(["fay"]);
    expect((await poolAsks(pool, fnf)).map((a) => a.via)).toEqual(["notice"]);
  });

  scenario("two games each with a pool notice waiting: a bare YES asks which, naming both, and asks nobody", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "two");
    await poolPlayer(pool, "gus", { at: near(fnf) });
    const second = await extraMatch(pool, fnf, 1);
    pool.arm(() => engineOn({ yes: { route: "approve" }, [BIBS]: { route: "none" } }));

    // Each game's 3-hour notice, a few minutes apart.
    expect((await noticePoll(pool, fnf, hoursBefore(fnf, 3.1))).some((p) => /MatchTime pool/.test(p.text))).toBe(true);
    expect((await noticePoll(pool, fnf, new Date(second.kickoff.getTime() - 3.9 * 3600_000))).some((p) => /MatchTime pool/.test(p.text))).toBe(true);
    await fnf.hq.say("alice", BIBS, { now: hoursBefore(fnf, 2.85), poolOpen: true });

    const ex = await fnf.hq.say("owner", "yes", { now: hoursBefore(fnf, 2.8), poolOpen: true });
    pool.expectSent(ex.sent, [
      {
        to: "two.hq",
        channel: "hq",
        text: /^Which one is that YES for: asking nearby players from the MatchTime player pool for .+, or asking nearby players from the MatchTime player pool for .+\? Reply YES to that message\.$/,
      },
    ]);
    expect(await poolAsks(pool, fnf)).toEqual([]);
  });
});
