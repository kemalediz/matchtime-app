/**
 * WHERE THE PLAYERS COME FROM, ASKED IN THE PLAYERS' GROUP (2026-10-28,
 * Friday MT Community: "@Match Time find me players feom partner clubs and
 * player pool" got "No new players to ask for Football 9-a-side right now.").
 * A club with no admin group asks here, and gets what HQ gets:
 *
 *   an unclear ask from an organiser, a club with partner clubs and the
 *   pool -> ONE question in the group, nobody asked -> "the pool" -> the
 *   pool is asked
 *   "partner clubs and the pool" -> the partner club AND the pool are asked
 *   now, in one round (Kemal, 2026-10-29: no waiting), ONE reply
 *   "the pool" with a partner round already open -> the pool is asked now,
 *   no partner ask made
 *   a player who is not an organiser -> the one line naming who can
 *
 * Real routes, real database. The model is STUBBED ($0): the router's route
 * and the admin extractor's facts are what the stub says; whether the real
 * model says them is the paid check (`scripts/live-check-ask-both.ts`).
 * Everything after is the shipped code: the engine's admin and tag gates,
 * the batch-final pass, what the club has, the logged question, the
 * safe-YES rule's positional test on the answer, `requestPartnerAsk` and
 * `requestPoolAsk` with every rule.
 */
import { scenario, scenarios, stubbedOnly, expect } from "./fixtures";
import { near, offersOf, openClub, poolPlayer, type OpenClubOpts } from "./offers-world";
import type { PoolWorld } from "./world";
import type { SentMessage } from "./transcript";
import { clearPipelineStubs } from "../../helpers/stub";

const ADMIN_FACTS = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", note: "", lookbackMatches: 0, clubRef: "" };
const recruitFrom = (playersFrom: string[]) => ({ action: "recruit", ...ADMIN_FACTS, playersFrom, toMatchTime: true });

const UNCLEAR = "@Match Time find us a player for Friday";
const UNCLEAR_TR = "@Match Time cumaya bir oyuncu bul";
const BOTH = "@Match Time find me players feom partner clubs and player pool";
const QUESTION = "Who shall I ask for players: your recent players, your partner clubs, or the MatchTime player pool?";
const QUESTION_TR = "Oyuncu için kime sorayım: son oyuncularınıza mı, partner kulüplerinize mi, yoksa MatchTime oyuncu havuzuna mı?";

type Club = Awaited<ReturnType<typeof openClub>>;

/** A club with NO admin group, the pool on, one place open, its game two days out. */
async function noHqClub(pool: PoolWorld, key: string, opts: OpenClubOpts & { language?: "en" | "tr" } = {}): Promise<Club> {
  const { language, ...clubOpts } = opts;
  const club = await openClub(pool, key, { name: "Friday MT Community", maxPlayers: 1, kickoffInHours: 48, ...clubOpts });
  await pool.db.run(`UPDATE "Organisation" SET "partnerAskCutoffHours" = 2, "partnerAskWhen" = 'on-request', language = $2 WHERE id = $1`, [club.group.orgId, language ?? "en"]);
  return club;
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

const say = (club: Club, member: string, text: string, opts: { route?: string; facts: Record<string, unknown>; tag?: boolean }) =>
  club.post(member, text, { route: opts.route ?? "admin_ops", facts: opts.facts, tag: opts.tag ?? true, headers: { "x-mt-test-pool-open": "1" } });
const poolAsks = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ via: string; roundId: string | null }>(`SELECT via, "roundId" FROM "PoolAsk" WHERE "orgId" = $1`, [club.group.orgId]);
const partnerAsks = (pool: PoolWorld, club: Club) =>
  pool.db.all<{ status: string; via: string; roundId: string | null }>(`SELECT status, "requestedVia" AS via, "roundId" FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [club.group.orgId]);
const groupLine = (ms: readonly SentMessage[], club: Club) => ms.find((m) => m.to === `${club.key}.group`)?.text;
const toMembers = (ms: readonly SentMessage[], club: Club) => ms.filter((m) => m.to.startsWith(`${club.key}.`) && m.to !== `${club.key}.group`);
const offers = (ms: readonly SentMessage[]) => ms.filter((m) => m.purpose === "pool-offer");

scenarios("players asked for in the players' group: several places, or MatchTime asks which", () => {
  scenario.afterEach(() => clearPipelineStubs());

  scenario("an organiser's unclear ask -> the question in the group, nobody asked -> 'the pool' -> the pool is asked", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "gas1");
    await partnerOf(pool, fmc, "cheamg1", "Cheam Lads");
    const ali = await poolPlayer(pool, "alig1", { name: "Ali Kaya", at: near(fmc) });

    const asked = await say(fmc, "owner", UNCLEAR, { facts: recruitFrom([]) });
    expect(groupLine(asked.sent, fmc)).toBe(QUESTION);
    expect(toMembers(asked.sent, fmc)).toEqual([]);
    expect(offers(asked.sent)).toEqual([]);
    expect(await poolAsks(pool, fmc)).toEqual([]);
    expect(await partnerAsks(pool, fmc)).toEqual([]);

    // The answer, untagged: the next organiser message after the question.
    const answered = await say(fmc, "owner", "the pool", { route: "none", facts: recruitFrom(["pool"]), tag: false });
    expect(groupLine(answered.sent, fmc)).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 1 place on /);
    expect(offers(answered.sent).map((m) => m.to)).toEqual(["alig1"]);
    expect((await poolAsks(pool, fmc)).map((a) => a.via)).toEqual(["words"]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
    expect(await partnerAsks(pool, fmc)).toEqual([]);
    expect(toMembers(answered.sent, fmc)).toEqual([]);
  });

  scenario("the owner's '@Match Time invite players from pool' routed admin_ops (2026-10-29 incident): the pool is asked, nobody else", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "gas6");
    const ali = await poolPlayer(pool, "alig6", { name: "Ali Kaya", at: near(fmc) });

    const ex = await say(fmc, "owner", "@Match Time invite players from pool", { route: "admin_ops", facts: recruitFrom(["pool"]) });
    expect(groupLine(ex.sent, fmc)).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 1 place on /);
    expect(offers(ex.sent).map((m) => m.to)).toEqual(["alig6"]);
    expect((await poolAsks(pool, fmc)).map((a) => a.via)).toEqual(["words"]);
    expect(await offersOf(pool, ali)).toHaveLength(1);
    expect(await partnerAsks(pool, fmc)).toEqual([]);
    expect(toMembers(ex.sent, fmc).filter((m) => m.purpose !== "pool-offer")).toEqual([]);
  });

  scenario("Turkish: the question in Turkish", async ({ pool }) => {
    stubbedOnly();
    const tr = await noHqClub(pool, "gas2", { language: "tr" });
    await partnerOf(pool, tr, "cheamg2", "Cheam Lads");
    const asked = await say(tr, "owner", UNCLEAR_TR, { facts: recruitFrom([]) });
    expect(groupLine(asked.sent, tr)).toBe(QUESTION_TR);
  });

  scenario("'partner clubs and the pool' (Kemal, 2026-10-29): both asked now, in one round; one reply, no DM blast", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "gas3");
    await partnerOf(pool, fmc, "cheamg3", "Cheam Lads");
    const bea = await poolPlayer(pool, "beag3", { at: near(fmc) });

    const ex = await say(fmc, "owner", BOTH, { facts: recruitFrom(["partners", "pool"]) });

    const xasks = await partnerAsks(pool, fmc);
    expect(xasks).toHaveLength(1);
    expect(xasks[0].via).toBe("group");
    const pasks = await poolAsks(pool, fmc);
    expect(pasks).toEqual([{ via: "words", roundId: xasks[0].roundId }]);
    // The pool never waits for the partners: its offer goes now.
    expect(offers(ex.sent).map((m) => m.to)).toEqual(["beag3"]);
    expect(await offersOf(pool, bea)).toHaveLength(1);
    const posts = ex.sent.filter((m) => m.to === "gas3.group");
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/Cheam Lads/);
    expect(posts[0].text).toMatch(/Asking nearby players from the MatchTime player pool for 1 place on .+, at the same time as your partner clubs\./);
    expect(posts[0].text).not.toMatch(/within the hour/);
    expect(toMembers(ex.sent, fmc).filter((m) => m.purpose !== "pool-offer")).toEqual([]);
  });

  scenario("'the pool' only, a partner round already open on the match: the pool is asked now, no partner ask made (Kemal, 2026-10-29)", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "gas5");
    await partnerOf(pool, fmc, "cheamg5", "Cheam Lads");
    const bea = await poolPlayer(pool, "beag5", { at: near(fmc) });
    await say(fmc, "owner", "@Match Time ask our partner clubs", { facts: recruitFrom(["partners"]) });
    const before = await partnerAsks(pool, fmc);
    expect(before).toHaveLength(1);
    expect(await poolAsks(pool, fmc)).toEqual([]);

    const ex = await say(fmc, "owner", "@Match Time ask the player pool", { facts: recruitFrom(["pool"]) });
    expect(await partnerAsks(pool, fmc)).toEqual(before);
    expect(await poolAsks(pool, fmc)).toEqual([{ via: "words", roundId: before[0].roundId }]);
    expect(offers(ex.sent).map((m) => m.to)).toEqual(["beag5"]);
    expect(await offersOf(pool, bea)).toHaveLength(1);
    expect(groupLine(ex.sent, fmc)).toMatch(/^🔎 Asking nearby players from the MatchTime player pool for 1 place on .+, at the same time as your partner clubs\./);
  });

  scenario("a player who is not an organiser: the one line naming who can, nothing asked", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "gas4");
    await partnerOf(pool, fmc, "cheamg4", "Cheam Lads");
    await poolPlayer(pool, "cang4", { at: near(fmc) });

    const ex = await say(fmc, "pete", UNCLEAR, { facts: recruitFrom([]) });
    expect(groupLine(ex.sent, fmc)).toMatch(/^Only .+ can change that\.$/);
    expect(ex.sent.filter((m) => m.channel === "dm")).toEqual([]);
    expect(await poolAsks(pool, fmc)).toEqual([]);
    expect(await partnerAsks(pool, fmc)).toEqual([]);

    // And a player's "the pool" after an organiser's question is not the answer.
    await say(fmc, "owner", UNCLEAR, { facts: recruitFrom([]) });
    await say(fmc, "pete", "the pool", { route: "none", facts: recruitFrom(["pool"]), tag: false });
    expect(await poolAsks(pool, fmc)).toEqual([]);
  });

  scenario("a club with neither partner clubs nor the pool: no question, the club's own recent players as before", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "gas5", { pool: { featurePlayerPool: false } });
    const ex = await say(fmc, "owner", UNCLEAR, { facts: recruitFrom([]) });
    // This club has no past games, so its recent players are nobody: said plainly.
    expect(groupLine(ex.sent, fmc)).toBe("None of your recent players are left to ask for *Friday MT Community* right now. 👍");
  });

  scenario("the club's own players asked and nobody left: the offer of the other places, and 'both' answers it", async ({ pool }) => {
    stubbedOnly();
    const fmc = await noHqClub(pool, "gas6");
    await partnerOf(pool, fmc, "cheamg6", "Cheam Lads");
    await poolPlayer(pool, "dua6", { at: near(fmc) });

    const ex = await say(fmc, "owner", "@Match Time ask the lads", { facts: recruitFrom(["club"]) });
    expect(groupLine(ex.sent, fmc)).toBe(
      "None of your recent players are left to ask for *Friday MT Community*. Want me to ask your partner clubs or the MatchTime player pool?",
    );
    expect(await poolAsks(pool, fmc)).toEqual([]);

    await say(fmc, "owner", "both", { route: "approve", facts: recruitFrom(["partners", "pool"]), tag: false });
    const xasks = await partnerAsks(pool, fmc);
    expect(xasks).toHaveLength(1);
    expect(await poolAsks(pool, fmc)).toEqual([{ via: "words", roundId: xasks[0].roundId }]);
  });
});
