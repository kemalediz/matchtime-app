/**
 * WHERE THE PLAYERS COME FROM, ASKED IN HQ (Kemal, 2026-10-28): "Only if
 * the admin specifically asks for players from the pool, in their own
 * words, can MatchTime do that. If MatchTime ... is in limbo between those
 * two features, MatchTime can ask the admin what they mean."
 *
 *   an ask that does not say where from, from a club with partner clubs
 *   and the pool -> ONE question in HQ, nobody asked -> the organiser
 *   answers "the pool" -> the pool is asked; answers "partners" -> the
 *   partner club is asked
 *
 * Real routes, real database. The model is STUBBED ($0): the router's
 * route and the admin extractor's facts are what the stub says (for the
 * ask, "recruit, from nowhere said"; for the answer, "recruit, from the
 * pool" or "from partners"); whether the real model says them is the paid
 * check (`scripts/live-check-ask-source.ts`). Everything after is the
 * shipped code: the outward gate, who may ask, what the club has, the
 * logged question, the safe-YES rule's positional test on the answer,
 * `requestPoolAsk` and `requestPartnerAsk` with every rule.
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { near, offersOf, openClub, poolPlayer, type OpenClubOpts } from "./offers-world";
import type { PoolWorld } from "./world";
import type { SentMessage } from "./transcript";
import { clearPipelineStubs, engineOn } from "../../helpers/stub";
import { londonDateTimeToUtc, formatLondon } from "../../../src/lib/london-time";

const ADMIN_FACTS = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0, clubRef: "" };
const recruitFrom = (playersFrom: string) => ({ action: "recruit", ...ADMIN_FACTS, playersFrom, toMatchTime: true });

const ASK_EN = "@Match Time we need a player for Thursday";
const ASK_TR = "@Match Time perşembeye 1 kişi lazım";
const QUESTION_ALL = "Who shall I ask for players: your players' group, your partner clubs, or the MatchTime player pool?";
const QUESTION_ALL_TR = "Oyuncu için kime sorayım: oyuncu grubunuza mı, partner kulüplerinize mi, yoksa MatchTime oyuncu havuzuna mı?";

type Club = Awaited<ReturnType<typeof openClub>>;

/** A club with HQ, the pool on, one place open, its game two days out. */
async function hqClub(pool: PoolWorld, key: string, opts: OpenClubOpts & { language?: "en" | "tr"; partnerAskWhen?: "off" | "on-request" | "auto" } = {}): Promise<Club> {
  const { language, partnerAskWhen, ...clubOpts } = opts;
  const club = await openClub(pool, key, { name: "FNF", hq: true, maxPlayers: 1, ...clubOpts });
  const day = formatLondon(new Date(Date.now() + 48 * 3600_000), "yyyy-MM-dd");
  const kickoff = londonDateTimeToUtc(day, "20:00");
  await pool.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [club.group.matchId, kickoff]);
  await pool.db.run(`UPDATE "Organisation" SET "partnerAskCutoffHours" = 2, "partnerAskWhen" = $3, language = $2 WHERE id = $1`, [
    club.group.orgId,
    language ?? "en",
    partnerAskWhen ?? "on-request",
  ]);
  return Object.assign(club, { kickoff });
}

/** A partner club the asker may ask, its organisers saying YES first. */
async function partnerOf(pool: PoolWorld, asker: Club, key: string, name: string): Promise<void> {
  const partner = await pool.club(key, { name, upcomingMatch: false });
  await pool.db.run(
    `INSERT INTO "ClubPartnership" (id, "askerOrgId", "partnerOrgId", status, "partnerApproval", "askerAcceptedAt", "partnerAcceptedAt", "createdByUserId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'active', 'each-ask', now(), now(), $4, now(), now())`,
    [`sim-pship-${key}-${Date.now()}`, asker.group.orgId, partner.group.orgId, (await pool.userOf(asker.member("owner")))!.id],
  );
}

const hoursBefore = (club: Club, h: number) => new Date(club.kickoff.getTime() - h * 3600_000);
const minutesAfter = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const poolAsks = (pool: PoolWorld, club: Club) => pool.db.all<{ via: string }>(`SELECT via FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId]);
const partnerAsks = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ status: string; via: string }>(`SELECT status, "requestedVia" AS via FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [club.group.orgId]);
const groupPosts = (ms: readonly SentMessage[], club: Club) => ms.filter((m) => m.to === `${club.key}.group`);
const offers = (ms: readonly SentMessage[]) => ms.filter((m) => m.purpose === "pool-offer");

scenarios("players asked for in HQ with no source named: MatchTime asks which", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("ambiguous ask -> the question -> 'the pool' -> the pool is asked, and only the pool", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "src1");
    await partnerOf(pool, fnf, "cheam1", "Cheam Lads");
    const ali = await poolPlayer(pool, "ali1", { name: "Ali Kaya", at: near(fnf) });
    pool.arm(() =>
      engineOn({
        [ASK_EN]: { route: "ask_group", facts: recruitFrom("unsaid") },
        // The router may call a bare answer anything; HQ reads it against the question.
        "the pool": { route: "none", facts: recruitFrom("pool") },
      }),
    );

    const t0 = hoursBefore(fnf, 30);
    const asked = await fnf.hq.say("owner", ASK_EN, { now: t0, poolOpen: true });
    pool.expectSent(asked.sent, [{ to: "src1.hq", channel: "hq", text: QUESTION_ALL }]);
    expect(asked.json).toMatchObject({ outcome: "hq-ask-source" });
    expect(await poolAsks(pool, fnf)).toEqual([]);
    expect(await partnerAsks(pool, fnf)).toEqual([]);
    expect(groupPosts(pool.sent, fnf)).toEqual([]);

    const answered = await fnf.hq.say("owner", "the pool", { tagged: true, now: minutesAfter(t0, 2), poolOpen: true });
    pool.expectSent(answered.sent, [
      { to: "src1.hq", channel: "hq", text: /^🔎 Asking nearby players from the MatchTime player pool for 1 place on .+, 20:00\./ },
      { to: "ali1", channel: "dm", purpose: "pool-offer", text: /⚽ \*FNF\* needs 1 player/ },
    ]);
    expect(await poolAsks(pool, fnf)).toEqual([{ via: "words" }]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
    expect(await partnerAsks(pool, fnf)).toEqual([]);
    expect(groupPosts(pool.sent, fnf)).toEqual([]);
  });

  scenario("ambiguous ask -> the question -> 'partners' -> the partner club is asked, never the pool", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "src2");
    await partnerOf(pool, fnf, "cheam2", "Cheam Lads");
    const bea = await poolPlayer(pool, "bea2", { at: near(fnf) });
    pool.arm(() =>
      engineOn({
        [ASK_EN]: { route: "ask_group", facts: recruitFrom("unsaid") },
        partners: { route: "approve", facts: recruitFrom("partners") },
      }),
    );

    const t0 = hoursBefore(fnf, 30);
    const asked = await fnf.hq.say("owner", ASK_EN, { now: t0, poolOpen: true });
    pool.expectSent(asked.sent, [{ to: "src2.hq", channel: "hq", text: QUESTION_ALL }]);

    const answered = await fnf.hq.say("owner", "partners", { tagged: true, now: minutesAfter(t0, 1), poolOpen: true });
    expect(answered.json).toMatchObject({ outcome: "xask-words-asked" });
    expect(answered.sent.find((m) => m.to === "src2.hq")?.text).toMatch(/Cheam Lads/);
    expect(await partnerAsks(pool, fnf)).toEqual([{ status: "awaiting-approval", via: "hq" }]);
    expect(await poolAsks(pool, fnf)).toEqual([]);
    expect(await offersOf(pool, bea)).toHaveLength(0);
    expect(offers(pool.sent)).toEqual([]);
  });

  scenario("'partner clubs and the pool' in HQ (Kemal, 2026-10-29): both asked now, the pool never waits; one reply", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "src6");
    await partnerOf(pool, fnf, "cheam6", "Cheam Lads");
    const ali = await poolPlayer(pool, "ali6", { at: near(fnf) });
    const BOTH = "@Match Time ask partner clubs and the player pool";
    pool.arm(() => engineOn({ [BOTH]: { route: "ask_group", facts: { action: "recruit", ...ADMIN_FACTS, playersFrom: ["partners", "pool"], toMatchTime: true } } }));

    const asked = await fnf.hq.say("owner", BOTH, { now: hoursBefore(fnf, 30), poolOpen: true });
    expect(await partnerAsks(pool, fnf)).toEqual([{ status: "awaiting-approval", via: "hq" }]);
    expect(await poolAsks(pool, fnf)).toEqual([{ via: "words" }]);
    expect(offers(asked.sent).map((m) => m.to)).toEqual(["ali6"]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
    const hq = asked.sent.filter((m) => m.to === "src6.hq");
    expect(hq).toHaveLength(1);
    expect(hq[0].text).toMatch(/Cheam Lads/);
    expect(hq[0].text).toMatch(/Asking nearby players from the MatchTime player pool for 1 place on .+, at the same time as your partner clubs\./);
    expect(hq[0].text).not.toMatch(/within the hour/);
  });

  scenario("Turkish: the question in Turkish, the club's own words", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "src3", { language: "tr" });
    await partnerOf(pool, fnf, "cheam3", "Cheam Lads");
    pool.arm(() => engineOn({ [ASK_TR]: { route: "ask_group", facts: recruitFrom("unsaid") } }));
    const asked = await fnf.hq.say("owner", ASK_TR, { now: hoursBefore(fnf, 30), poolOpen: true });
    pool.expectSent(asked.sent, [{ to: "src3.hq", channel: "hq", text: QUESTION_ALL_TR }]);
  });

  scenario("only the pool (no partner club): the question names the group and the pool, never partners", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "src4");
    pool.arm(() => engineOn({ [ASK_EN]: { route: "ask_group", facts: recruitFrom("unsaid") } }));
    const asked = await fnf.hq.say("owner", ASK_EN, { now: hoursBefore(fnf, 30), poolOpen: true });
    pool.expectSent(asked.sent, [{ to: "src4.hq", channel: "hq", text: "Who shall I ask for players: your players' group, or the MatchTime player pool?" }]);
  });

  scenario("neither (the pool off, no partner club): the players' group is asked, as before; no question", async ({ pool }) => {
    stubbedOnly();
    const fnf = await hqClub(pool, "src5");
    pool.arm(() => engineOn({ [ASK_EN]: { route: "ask_group", facts: recruitFrom("unsaid") } }));
    const asked = await fnf.hq.say("owner", ASK_EN, { now: hoursBefore(fnf, 30), poolOpen: false });
    expect(asked.json).toMatchObject({ outcome: "group-asked" });
    expect(asked.sent.some((m) => m.text === QUESTION_ALL)).toBe(false);
    expect(await poolAsks(pool, fnf)).toEqual([]);
  });
});
